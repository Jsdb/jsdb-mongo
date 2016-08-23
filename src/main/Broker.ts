import * as SocketIO from 'socket.io';
import * as Mongo from 'mongodb';
import * as Debug from 'debug';

var dbgBroker = Debug('tsdb:mongo:broker');
var dbgOplog = Debug('tsdb:mongo:oplog');
var dbgSocket = Debug('tsdb:mongo:socket');
var dbgHandler = Debug('tsdb:mongo:handler');


export interface AuthService {
    authenticate(socket :SocketIO.Socket):Promise<Object>;
}

class NopAuthService implements AuthService {
    authenticate(socket :SocketIO.Socket):Promise<Object> {
        return Promise.resolve({});
    }
}

var progHandler = 0;

export class Broker {

    private id = progHandler++;

    private socket: SocketIO.Server;

    private collectionDb: Mongo.Db;
    private oplogDb: Mongo.Db;

    private collection: Mongo.Collection;
    private oplog: Mongo.Collection;

    private auth :AuthService = new NopAuthService();

    private collectionNs :string;

    private started = false;
    private closed = false;
    private startWait :Promise<any>[] = [];

    private handlers :{[index:string]:Handler} = {};
    private subscriptions :{[index:string]:{[index:string]:Handler}} = {};
    private lastOplogStream :Mongo.Cursor;

    constructor($socket?: SocketIO.Server, collectionDb?: string, collectionName?: string, oplogDb?: string, collectionOptions? :any) {
        dbgBroker("Created broker %s", this.id);
        this.socket = $socket;
        if (collectionDb && collectionName) {
            this.initCollection(collectionDb, collectionName, collectionOptions);
        }
        if (oplogDb) {
            this.initOplog(oplogDb);
        }
    }


    public setSocket(value: SocketIO.Server) :this {
        if (this.started) throw new Error("Cannot change the socket on an already started broker");
        this.socket = value;
        return this;
    }


    public setCollection(value: Mongo.Collection) :this {
        if (this.started) throw new Error("Cannot change the collection on an already started broker");
        this.collection = value;
        this.collectionNs = this.collection.namespace;
        return this;
    }


    public setOplogDb(value: Mongo.Db) :this {
        if (this.started) throw new Error("Cannot change the oplog db on an already started broker");
        this.oplogDb = value;
        this.oplog = this.oplogDb.collection('oplog.rs');
        return this;
    }

    public initCollection(collectionDb :string, collectionName :string, collectionOptions? :Mongo.MongoClientOptions) :this {
        if (this.started) throw new Error("Cannot change the collection on an already started broker");
        this.startWait.push(Mongo.MongoClient.connect(collectionDb, collectionOptions).then((db)=>{
            this.collectionDb = db;
            this.collection = this.collectionDb.collection(collectionName);
        }));
        return this;
    }

    public initOplog(oplogDb :string) :this {
        if (this.started) throw new Error("Cannot change the oplog on an already started broker");        
        this.startWait.push(Mongo.MongoClient.connect(oplogDb).then((db)=>{
            this.oplogDb = db;
            this.oplog = this.oplogDb.collection('oplog.rs');
        }));
        return this;
    }


	public setAuthService(value: AuthService) :this {
        if (this.started) throw new Error("Cannot change the auth service on an already started broker");        
		this.auth = value;
        return this;
	}
    

    start() :Promise<any> {
        if (this.closed) throw new Error("Cannot restart and already closed broker");
        if (this.started) {
            dbgBroker("Broker was already started");
            return;
        }
        dbgBroker("Starting broker, waiting " + this.startWait.length + " promises to complete");
        this.started = true;

        // Wait for connections to be made
        return Promise.all(this.startWait).then(()=>{
            dbgBroker("Hooking on socket");
            // Hook the socket
            this.socket.on('connect', (sock) => {
                if (this.closed) return;
                dbgSocket("Got connection %s from %s", sock.id, sock.client.conn.remoteAddress);
                this.auth.authenticate(sock).then((authData)=>{
                    dbgSocket("Authenticated %s with data %o", sock.id, authData);
                    // Create a handler for this connection
                    var handler = new Handler(sock, authData, this);
                });
            });

            // Hook the oplog
            dbgBroker("Hooking on oplog");
            return this.hookOplog();
        });
    }

    private hookOplog() :Promise<any> {
        if (!this.oplog) return;
        if (this.closed) return;
        return this.oplog.find({}).project({ts:1}).sort({$natural:-1}).limit(1).toArray().then((max)=>{
            if (this.closed) return;
            var maxtime = new Mongo.Timestamp(0, Math.floor(new Date().getTime() / 1000));
            if (max && max.length && max[0].ts) maxtime = max[0].ts;
            var oplogStream = this.oplog
                .find({ts:{$gt:maxtime}})
                .project({op:1,o:1,o2:1})
                .addCursorFlag('tailable', true)
                .addCursorFlag('awaitData', true)
                .addCursorFlag('oplogReplay', true)
                .setCursorOption('numberOfRetries',-1)
                .stream();
            oplogStream.on('data', (d:any)=>{
                // Find and notify registered handlers
                dbgOplog('%s : %o', this.id, d);
                if (d.op == 'i') {
                    // It's an insert of new data
                    this.broadcast(d.o._id, d.o);
                } else if (d.op == 'u') {
                    // Update of leaf data(s)
                    var dset = d.o.$set;
                    for (var k in dset) {
                        this.broadcast(d.o2._id + '/' + k, dset[k]);
                    }
                    dset = d.o.$unset;
                    for (var k in dset) {
                        this.broadcast(d.o2._id + '/' + k, null);
                    }
                    var updo = d.o;
                    delete updo.$set;
                    delete updo.$unset;
                    var empt = true;
                    for (var k in updo) {
                        empt = false;
                        break;
                    }
                    if (!empt) {
                        this.broadcast(d.o2._id, updo);
                    }
                } else if (d.op == 'd') {
                    // Parse and broadcast the delete
                    this.broadcast(d.o._id, null);
                }
            });
            oplogStream.on('close', ()=>{
                // Re-hook
                if (this.closed) return;
                dbgBroker("Re-hooking on oplog after a close event");
                this.hookOplog();
            });
            oplogStream.on('error', (e:any)=>{
                // Re-hook
                dbgBroker("Re-hooking on oplog after error", e);
                this.hookOplog();
            });
            this.lastOplogStream = oplogStream;
        });
    }

    register(handler :Handler) {
        this.handlers[handler.id] = handler;
    }

    unregister(handler :Handler) {
        delete this.handlers[handler.id];
    }

    subscribe(handler :Handler, path :string) {
        path = Broker.normalizePath(path);
        var ps = this.subscriptions[path];
        if (!ps) {
            this.subscriptions[path] = ps = {};
        }
        ps[handler.id] = handler;
    }

    unsubscribe(handler :Handler, path :string) {
        path = Broker.normalizePath(path);
        var ps = this.subscriptions[path];
        if (!ps) return;
        delete ps[handler.id];
        for (var key in ps) {
            if (hasOwnProperty.call(ps, key)) return;
        }
        delete this.subscriptions[path];
    }

    broadcast(path :string, val :any) {
        var alreadySent :{[index:string]:Handler} = {};
        this.broadcastDown(path, val, alreadySent);
        this.broadcastUp(Broker.parentPath(path), val, path, alreadySent);
    }

    private broadcastDown(path :string, val :any, alreadySent :{[index:string]:Handler}) {
        if (val == null) {
            for (var k in this.subscriptions) {
                if (k.indexOf(path) == 0) {
                    this.broadcastToHandlers(k, null, alreadySent);
                }
            }
        }
        if (typeof(val) == 'object' || typeof(val) == 'function') {
            for (var k in val) {
                this.broadcastDown(path + '/' + k, val[k], alreadySent);
            }
        }
        this.broadcastToHandlers(path, val, alreadySent);
    }

    private broadcastUp(path :string, val :any, fullpath :string, alreadySent :{[index:string]:Handler}) {
        this.broadcastToHandlers(path, val, alreadySent, fullpath);
        if (path.length == 0) return;
        path = Broker.parentPath(path);
        this.broadcastUp(path, val, fullpath, alreadySent);
    }

    private broadcastToHandlers(path :string, val :any, alreadySent :{[index:string]:Handler}, fullpath? :string) {
        var ps = this.subscriptions[path];
        if (!ps) return;
        var tspath = fullpath || path;
        for (var k in ps) {
            if (alreadySent[k]) continue;
            var handler = ps[k];
            // TODO sending only one event is not that simple, the event should be the right one, at the right depth in the tree
            //alreadySent[k] = handler; 
            if (handler.closed) {
                delete ps[k];
                continue;
            }
            handler.sendValue(tspath, val);
        }
    }

    close() :Promise<any> {
        if (!this.started) return;
        if (this.closed) {
            dbgBroker("Closing already closed broker %s", this.id);
            return;
        }
        dbgBroker("Closing broker %s", this.id);
        // Sttings closed to true will stop re-hooking the oplog and handing incoming socket connections
        this.closed = true;

        var proms :Promise<any>[] = [];

        if (this.lastOplogStream) {
            proms.push(this.lastOplogStream.close());
        }

        var handlerKeys = Object.getOwnPropertyNames(this.handlers);
        for (var i = 0; i < handlerKeys.length; i++) {
            var handler = this.handlers[handlerKeys[i]];
            if (handler) handler.close();
        }

        return Promise.all(proms);
    }

    static normalizePath(path :string) {
        path = path.replace(/\/\.+\//g,'/');
        path = path.replace(/\/\/+/g,'/');
        if (path.charAt(0) != '/') path = '/' + path;
        if (path.charAt(path.length-1) == '/') path = path.substr(0,path.length-1);
        return path;
    }

    static leafPath(path :string) :string {
        return path.substr(path.lastIndexOf('/') + 1);
    }

    static parentPath(path :string) :string {
        return path.substr(0, path.lastIndexOf('/'));
    }

    static pathRegexp(path :string) :RegExp {
        path = path.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
        return new RegExp('^' + path + '.*');
    }

    del(handler :Handler, paths :string[]) :Promise<any> {
        var ops :any[] = [];
        for (var i = 0; i < paths.length; i++) {
            ops[i] = {
                deleteMany: {
                    filter: {
                        _id: Broker.pathRegexp(paths[i])
                    }
                }
            }
        }
        return this.collection.bulkWrite(ops);
    }
    set(handler :Handler, path :string, val :any) :Promise<any> {
        path = Broker.normalizePath(path);
        if (val === null) {
            var leaf = Broker.leafPath(path);
            if (!leaf) throw new Error('Cannot write a primitive value on root');
            var par = Broker.parentPath(path);
            dbgBroker("Unsetting %s -> %s", par, leaf);
            var obj :any = {};
            obj[leaf] = 1;
            return Promise.all([
                this.del(handler, [path]),
                this.collection.updateOne({_id:par},{$unset:obj})
            ]);
        }
        if (typeof val == 'string' || typeof val == 'number' || typeof val == 'boolean') {
            // Saving a primitive value
            var leaf = Broker.leafPath(path);
            if (!leaf) throw new Error('Cannot write a primitive value on root');
            var par = Broker.parentPath(path);
            dbgBroker("Setting %s -> %s = %s", par, leaf, val);
            var obj :any = {};
            obj[leaf] = val;
            return Promise.all([
                this.del(handler, [path]),
                this.collection.updateOne({_id:par},{$set:obj},{upsert:true})
            ]);
        }

        return this.collection.find({_id:Broker.pathRegexp(path)}).sort({_id:1}).toArray().then((pres)=>{
            var premap :{[index:string]:any} = {};
            for (var i = 0; i < pres.length; i++) {
                var pre = pres[i];
                premap[pre._id] = pre;
            }

            // Saving a complex object
            var unrolled :any[] = [];
            var deletes :any[] = [];
            this.recursiveUnroll(path, val, unrolled, deletes);
            if (unrolled.length == 0) {
                dbgBroker("Nothing to write in path %s with val %o", path, val);
                return Promise.resolve();
            }
            var ops :any[] = [];
            for (var i = 0; i < unrolled.length; i++) {
                delete premap[unrolled[i]._id];
                ops[i] = {
                    updateOne: {
                        filter: {_id : unrolled[i]._id},
                        update: unrolled[i],
                        upsert: true
                    }
                }
            }

            var delpaths :string[] = [];
            for (var k in premap) {
                delpaths.push(k);
            }
            this.del(handler, delpaths);

            dbgBroker("For %s writing %s updates and %s delete operations in path %s with val %o", handler.id, ops.length, delpaths.length, path, val);
            return this.collection.bulkWrite(ops);
        });
    }

    recursiveUnroll(path :string, val :any, writes :any[] = [], dels :string[] = []) {
        var myobj :any = {
            _id :path
        };
        var atlo = false;
        for (var k in val) {
            var subv = val[k];
            if (typeof(subv) == 'function' || typeof(subv) == 'object') {
                this.recursiveUnroll(path + '/' + k, subv, writes, dels);
                continue; 
            }
            if (subv === null) {
                dels.push(path + '/' + k);
            }
            atlo = true;
            myobj[k] = val[k];
        }
        if (atlo) {
            writes.push(myobj);
        }
    }

    fetch(handler :Handler, path :string) {
        dbgBroker('Fetching %s for %s', path, handler.id);
        path = Broker.normalizePath(path);
        this.collection
            .find({_id:Broker.pathRegexp(path)}).sort({_id:1})
            .toArray()
            .then((data)=>{
                if (data.length != 0) {
                    dbgBroker("Found %s bag objects to recompose", data.length);
                    this.stream(handler, path, data);
                    return;
                } 
                this.collection.findOne({_id:Broker.parentPath(path)}).then((val)=>{
                    if (val == null) {
                        dbgBroker("Found no value on parent path");
                        handler.sendValue(path, null);
                    } else {
                        var leaf = Broker.leafPath(path);
                        dbgBroker("Found %s on parent path", val[leaf]);
                        handler.sendValue(path, val[leaf]);
                    }
                });
            })
            .catch((e)=>{
                dbgBroker("Had error %s", e);
                // TODO handle this errors differently
            });
    }

    stream(handler :Handler, path :string, data :any[]) {
        // recompose the object and send it
        var recomposer = new Recomposer(path);
        for (var i = 0; i < data.length; i++) {
            recomposer.add(data[i]);
        }
        handler.sendValue(path,recomposer.get());
    }
}

// Does not need to export, but there are no friendly/package/module accessible methods, and Broker.subscribe will complain is Handler is private
export class Handler {

    id = 'na';
    closed = false;
    private pathSubs :{[index:string]:boolean} = {};

 
    constructor(
        private socket :SocketIO.Socket,
        private authData :Object,
        private broker :Broker
    ) {
        this.id = socket.id.substr(2);
        socket.on('sp', (path:string,fn:Function)=>fn(this.subscribePath(path)));
        socket.on('up', (path:string,fn:Function)=>fn(this.unsubscribePath(path)));
        socket.on('pi', (id:string,fn:Function)=>fn(this.ping(id)));
        
        socket.on('s', (path:string, val :any, fn:Function)=>this.set(path,val, fn));

        socket.on('disconnect', ()=>{
            this.close();
        });

        broker.register(this);

        socket.emit('aa');
    }

    close() {
        dbgHandler("%s closing handler", this.id);
        if (this.closed) return;
        this.closed = true;
        this.socket.removeAllListeners();
        this.socket = null;
        for (var k in this.pathSubs) {
            this.broker.unsubscribe(this,k);
        }
        // TODO stop ongoing fetch operations?
        this.broker.unregister(this);
        this.broker = null;
        this.authData = null;
    }

    subscribePath(path :string) {
        if (this.pathSubs[path]) {
            dbgHandler("%s was already subscribed to %s", this.id, path);
            return 'k';
        }
        dbgHandler("%s subscribing to %s", this.id, path);
        this.pathSubs[path] = true;
        this.broker.subscribe(this, path);
        this.broker.fetch(this, path);
        return 'k';
    }
    unsubscribePath(path :string) {
        if (!this.pathSubs[path]) {
            dbgHandler("%s was already unsubscribed from %s", this.id, path);
            return 'k';
        }
        dbgHandler("%s unsubscribing from %s", this.id, path);
        delete this.pathSubs[path];
        this.broker.unsubscribe(this, path);
        return 'k';
    }

    ping(id :string) {
        dbgHandler("%s received ping %s", this.id, id);
        return id;
    }

    set(path :string, val :any, cb :Function) {
        dbgHandler("%s writing in %s %o", this.id, path, val);
        // TODO security here
        this.broker.set(this, path, val).then(()=>cb('k')).catch((e)=>{
            dbgHandler("Got error", e);
            // TODO how to handle errors?
        });
    }

    sendValue(path :string, val :any) {
        // TODO security filter here?
        this.socket.emit('v', {p:path,v:val});
    }
}

export class Recomposer {
    base :string;

    refs :{[index:string]:any} = {};

    constructor(base :string) {
        this.base = Broker.normalizePath(base);
    }

    add(obj :any) {
        var path = obj._id;
        this.findOrCreateRefFor(path, obj);
    }

    get() {
        return this.refs[this.base];
    }

    private findOrCreateRefFor(path :string, obj :any) {
        if (obj._id) delete obj._id;
        var acref = this.refs[path];
        if (acref) {
            if (obj) {
                for (var k in obj) {
                    acref[k] = obj[k];
                }
            }
        } else {
            acref = obj;
            this.refs[path] = acref;
        }
        if (path == this.base) return;
        var par = Broker.parentPath(path);
        var lst = Broker.leafPath(path);
        var preobj :any = {};
        preobj[lst] = acref;
        this.findOrCreateRefFor(par, preobj);
    }
}


var hasOwnProperty = Object.prototype.hasOwnProperty;