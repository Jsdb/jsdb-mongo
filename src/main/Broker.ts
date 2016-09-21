/**
 * TSDB Mongo VERSION_TAG
 */

import * as SocketIO from 'socket.io';
import * as Mongo from 'mongodb';
import * as Debug from 'debug';

import * as Utils from './Utils';

import {EventEmitter} from 'events';

var dbgBroker = Debug('tsdb:mongo:broker');
var dbgQuery = Debug('tsdb:mongo:query');
var dbgOplog = Debug('tsdb:mongo:oplog');
var dbgSocket = Debug('tsdb:mongo:socket');
var dbgHandler = Debug('tsdb:mongo:handler');

export var VERSION = "VERSION_TAG";

export interface AuthService {
    authenticate(socket :Socket, data :any):Promise<Object>;
}

class NopAuthService implements AuthService {
    authenticate(socket :Socket):Promise<Object> {
        return Promise.resolve({});
    }
}

var progHandler = 0;

export interface Socket {
    id :string;
    on(event :string, cb :(...args :any[])=>any) :any;
    emit(event :string, ...args :any[]) :any;
    removeListener(event :string, cb :(...args :any[])=>any) :any;
    removeAllListeners() :void;
}

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
    private subscriptions :{[index:string]:{[index:string]:Subscriber}} = {};

    private oplogMaxtime :Mongo.Timestamp = null;
    private oplogStream :Mongo.Cursor = null;


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


    public setSocketServer(value: SocketIO.Server) :this {
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
        dbgBroker("Connecting to collection on url %s collection %s options %o", collectionDb, collectionName, collectionOptions);
        this.startWait.push(Mongo.MongoClient.connect(collectionDb, collectionOptions).then((db)=>{
            dbgBroker("Connected to db, opening %s collection", collectionName);
            this.collectionDb = db;
            this.collection = this.collectionDb.collection(collectionName);
        }).then(()=>{
            dbgBroker("Connected to collection");
        }).catch((err)=>{
            console.warn("Error opening collection connection",err);
            return Promise.reject(err);
        }));
        return this;
    }

    public initOplog(oplogDb :string) :this {
        if (this.started) throw new Error("Cannot change the oplog on an already started broker");
        dbgBroker("Connecting oplog %s", oplogDb);
        this.startWait.push(Mongo.MongoClient.connect(oplogDb).then((db)=>{
            dbgBroker("Connected to db, opening oplog.rs collection");
            this.oplogDb = db;
            this.oplog = this.oplogDb.collection('oplog.rs');
        }).then(()=>{
            dbgBroker("Connected to oplog");
        }).catch((err)=>{
            console.warn("Error opening oplog connection",err);
            return Promise.reject(err);
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
            if (this.socket) {
                dbgBroker("Hooking on socket");
                // Hook the socket
                this.socket.on('connect', (sock) => {
                    if (this.closed) return;
                    dbgSocket("Got connection %s from %s", sock.id, sock.client.conn.remoteAddress);
                    this.auth.authenticate(sock, null).then((authData)=>{
                        dbgSocket("Authenticated %s with data %o", sock.id, authData);
                        // Create a handler for this connection
                        this.handle(sock, authData);
                    });
                });
            }

            // Hook the oplog
            dbgBroker("Hooking on oplog");
            return this.hookOplog();
        });
    }

    public handle(sock :Socket, authData :any) :Handler {
        var handler = new Handler(sock, authData, this);
        sock.on('auth', (data:any)=>{
            this.auth.authenticate(sock, data).then((authData)=>{
                handler.updateAuthData(authData);
            });
        });
        return handler;
    }

    private hookOplog() :Promise<any> {
        if (!this.oplog) return;
        if (this.closed) return;
        var findMaxProm :Promise<Mongo.Timestamp> = null;
        if (!this.oplogMaxtime) {
            findMaxProm = this.oplog.find({}).project({ts:1}).sort({$natural:-1}).limit(1).toArray().then((max)=>{
                var maxtime = new Mongo.Timestamp(0, Math.floor(new Date().getTime() / 1000));
                if (max && max.length && max[0].ts) maxtime = max[0].ts;
                return maxtime;
            });
        } else {
            findMaxProm = Promise.resolve(this.oplogMaxtime);
        }
        return findMaxProm.then((maxtime)=>{
            if (this.closed) return;
            if (this.oplogStream) this.oplogStream.close();
            var oplogStream = this.oplogStream = this.oplog
                .find({ts:{$gt:maxtime}})
                .project({op:1,o:1,o2:1,ts:1})
                .addCursorFlag('tailable', true)
                .addCursorFlag('awaitData', true)
                .addCursorFlag('oplogReplay', true)
                .setCursorOption('numberOfRetries',-1)
                .stream();
            oplogStream.on('data', (d:any)=>{
                // Find and notify registered handlers
                dbgOplog('%s : %o', this.id, d);
                this.oplogMaxtime = d.ts;
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
                if (this.oplogStream === oplogStream) {
                    dbgBroker("Re-hooking on oplog after a close event");
                    this.hookOplog();
                }
            });
            oplogStream.on('error', (e:any)=>{
                // Re-hook
                dbgBroker("Re-hooking on oplog after error", e);
                oplogStream.close();
            });
        });
    }

    register(handler :Handler) {
        this.handlers[handler.id] = handler;
    }

    unregister(handler :Handler) {
        delete this.handlers[handler.id];
    }

    subscribe(handler :Subscriber, path :string) {
        path = Utils.normalizePath(path);
        var ps = this.subscriptions[path];
        if (!ps) {
            this.subscriptions[path] = ps = {};
        }
        ps[handler.id] = handler;
    }

    unsubscribe(handler :Subscriber, path :string) {
        path = Utils.normalizePath(path);
        var ps = this.subscriptions[path];
        if (!ps) return;
        delete ps[handler.id];
        for (var key in ps) {
            if (hasOwnProperty.call(ps, key)) return;
        }
        delete this.subscriptions[path];
    }

    broadcast(path :string, val :any) {
        var alreadySent :{[index:string]:Subscriber} = {};
        this.broadcastDown(path, val, alreadySent);
        this.broadcastUp(Utils.parentPath(path), val, path, alreadySent);
    }

    private broadcastDown(path :string, val :any, alreadySent :{[index:string]:Subscriber}) {
        if (val == null) {
            for (var k in this.subscriptions) {
                if (k.indexOf(path) == 0) {
                    this.broadcastToHandlers(k, null, alreadySent);
                }
            }
        } else if (typeof(val) == 'object' || typeof(val) == 'function') {
            delete val._id;
            for (var k in val) {
                this.broadcastDown(path + '/' + k, val[k], alreadySent);
            }
        }
        this.broadcastToHandlers(path, val, alreadySent);
    }

    private broadcastUp(path :string, val :any, fullpath :string, alreadySent :{[index:string]:Subscriber}) {
        if (!path) return;
        if (val && val._id) delete val._id;
        this.broadcastToHandlers(path, val, alreadySent, fullpath);
        if (path.length == 0) return;
        this.broadcastUp(Utils.parentPath(path), val, fullpath, alreadySent);
    }

    private broadcastToHandlers(path :string, val :any, alreadySent :{[index:string]:Subscriber}, fullpath? :string) {
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
            handler.sendValue(tspath, val, handler.writeProg);
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

        if (this.oplogStream) {
            proms.push(this.oplogStream.close());
        }

        var handlerKeys = Object.getOwnPropertyNames(this.handlers);
        for (var i = 0; i < handlerKeys.length; i++) {
            var handler = this.handlers[handlerKeys[i]];
            if (handler) handler.close();
        }

        return Promise.all(proms);
    }

    del(handler :Handler, paths :string[]) :Promise<any> {
        var ops :any[] = [];
        for (var i = 0; i < paths.length; i++) {
            ops[i] = {
                deleteMany: {
                    filter: {
                        _id: Utils.pathRegexp(paths[i])
                    }
                }
            }
        }
        if (ops.length == 0) return Promise.resolve(null);
        return this.collection.bulkWrite(ops);
    }

    merge(handler :Handler, path :string, val :any) :Promise<any> {
        path = Utils.normalizePath(path);

        var proms :Promise<any>[] = [];
        for (var k in val) {
            if (val[k] == null) {
                proms.push(this.set(handler,path+'/'+k,null));
            } else {
                proms.push(this.set(handler,path+'/'+k,val[k]));
            }
        }
        return Promise.all(proms);
    }

    set(handler :Handler, path :string, val :any) :Promise<any> {
        path = Utils.normalizePath(path);
        if (val !== null && (typeof val == 'string' || typeof val == 'number' || typeof val == 'boolean')) {
            // Saving a primitive value
            var leaf = Utils.leafPath(path);
            if (!leaf) throw new Error('Cannot write a primitive value on root');
            var par = Utils.parentPath(path);
            dbgBroker("Setting %s -> %s = %s", par, leaf, val);
            var obj :any = {};
            obj[leaf] = val;
            return Promise.all([
                this.del(handler, [path]),
                this.collection.updateOne({_id:par},{$set:obj},{upsert:true})
            ]);
        }
        if (val === null || Utils.isEmpty(val)) {
            var leaf = Utils.leafPath(path);
            //if (!leaf) throw new Error('Cannot write a primitive value on root');
            var par = Utils.parentPath(path);
            dbgBroker("Unsetting %s -> %s", par, leaf);
            var obj :any = {};
            obj[leaf] = 1;
            return Promise.all([
                this.del(handler, [path]),
                this.collection.updateOne({_id:par},{$unset:obj})
            ]);
        }

        return this.collection.find({_id:Utils.pathRegexp(path)}).sort({_id:1}).toArray().then((pres)=>{
            var premap :{[index:string]:any} = {};
            for (var i = 0; i < pres.length; i++) {
                var pre = pres[i];
                premap[pre._id] = pre;
            }

            // Saving a complex object
            var unrolled :any[] = [];
            this.recursiveUnroll(path, val, unrolled);
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

            dbgBroker("For %s writing %s updates and %s delete operations in path %s with val %s", handler.id, ops.length, delpaths.length, path, JSON.stringify(ops));
            return this.collection.bulkWrite(ops, {ordered:false}).then((res)=>{
                var rres = <Mongo.BulkWriteResult>res;
                if (!rres.hasWriteErrors()) return null;
                throw new Error("Not all requested operations performed correctly : %o " + rres.getWriteErrors());
            });
        });
    }

    recursiveUnroll(path :string, val :any, writes :any[] = [], dels :string[] = []) {
        var myobj :any = {
            _id :path
        };
        var atlo = false;
        for (var k in val) {
            var subv = val[k];
            if (subv == null) {
                dels.push(path + '/' + k);
                continue;
            }
            if (typeof(subv) == 'function' || typeof(subv) == 'object') {
                this.recursiveUnroll(path + '/' + k, subv, writes, dels);
                continue; 
            }
            atlo = true;
            myobj[k] = val[k];
        }
        if (atlo) {
            writes.push(myobj);
        }
    }

    fetch(handler :Subscriber, path :string, extra? :any) :Promise<any> {
        dbgBroker('Fetching %s for %s', path, handler.id);
        path = Utils.normalizePath(path);
        var preprog = handler.writeProg || null;
        return this.collection
            .find({_id:Utils.pathRegexp(path)}).sort({_id:1})
            // TODO Replace this with .stream() so that it's interruptible
            .toArray()
            .then((data)=>{
                if (data.length != 0) {
                    dbgBroker("Found %s bag objects to recompose", data.length);
                    // TODO consider streaming data progressively
                    /*
                    to be exact :
                    - while looping on data
                    - if we pass from one child to another child
                    - if the child is not a native, switch to "streaming" mode
                    - in streaming mode, send a separate value event for each child 
                    */ 
                    // recompose the object and send it
                    var recomposer = new Recomposer(path);
                    for (var i = 0; i < data.length; i++) {
                        recomposer.add(data[i]);
                    }
                    handler.sendValue(path,recomposer.get(), preprog, extra);
                    return;
                } 
                this.collection.findOne({_id:Utils.parentPath(path)}).then((val)=>{
                    if (val == null) {
                        dbgBroker("Found no value on path %s using parent", path);
                        handler.sendValue(path, null, preprog, extra);
                    } else {
                        var leaf = Utils.leafPath(path);
                        dbgBroker("Found %s on path %s using parent", val[leaf], path);
                        handler.sendValue(path, val[leaf], preprog, extra);
                    }
                });
            })
            .catch((e)=>{
                dbgBroker("Had error %s", e);
                // TODO handle this errors differently
            });
    }

    query(queryState :SimpleQueryState) {
        var qo :any = {};

        var def = queryState.def;

        qo._id = queryState.pathRegex;
        if (def.compareField) {
            var leafField = Utils.leafPath(def.compareField);
            if (typeof(def.equals) !== 'undefined') {
                qo[leafField] = def.equals;
            } else if (typeof(def.from) !== 'undefined' || typeof(def.to) !== 'undefined') {
                qo[leafField] = {};
                if (typeof(def.from) !== 'undefined') qo[leafField].$gt = def.from;
                if (typeof(def.to) !== 'undefined') qo[leafField].$lt = def.to;
            }
        }

        dbgBroker("%s query object %o", queryState.id, qo);

        var cursor = this.collection.find(qo);

        var sortobj :any = {};
        if (def.compareField && typeof(def.equals) == 'undefined') {
            sortobj[def.compareField] = def.limitLast ? -1 : 1;
        } else {
            sortobj['_id'] = def.limitLast ? -1 : 1;
        }
        cursor = cursor.sort(sortobj);

        if (def.limit) {
            cursor = cursor.limit(def.limit);
        }

        //return cursor.toArray().then((data)=>console.log(data));

        cursor = cursor.stream();

        cursor.on('data', (data :any)=>{
            var elementUrl = Utils.limitToChild(data._id, def.path);
            queryState.found(elementUrl, data);
        });
        cursor.on('end', ()=>{
            queryState.foundEnd();
            dbgBroker("%s cursor end", def.id);
        });
    }

}

export interface SimpleQueryDef {
    /**
     * Internal id used to cache and handle queries
     */
    id? :string; 

    path? :string;

    // Query part, what to compare, wether to find equals or limit from->to
    compareField? :string;
    equals? :any;
    from? :string;
    to? :string;

    // Limit by number
    limit? :number;
    limitLast? :boolean;
}

export interface Subscriber {
    id :string;
    closed :boolean;
    writeProg? :number;
    sendValue(path :string, val :any, prog :number, extra? :any) :void;
}

class ForwardingSubscriber implements Subscriber {
    constructor(
        public id :string,
        protected from :Subscriber,
        protected to :Subscriber) 
    {

    }

    get closed() {
        return this.from.closed || this.to.closed;
    }

    get writeProg() {
        return this.to.writeProg;
    }

    sendValue(path :string, val :any, prog :number, extra? :any) :void {
        this.to.sendValue(path, val, prog, extra);
    }
}

class SortAwareForwardingSubscriber extends ForwardingSubscriber {
    protected sorting = true;
    protected sent :{[index:string]:boolean} = {};
    protected cached :{[index:string]:any} = {};
    protected cachedUpd :{[index:string]:any[]} = {};


    sendValue(path :string, val :any, prog :number, extra? :any) :void {
        if (!this.sorting) {
            super.sendValue(path, val, prog, extra);
            return;
        }
        if (!extra.q) {
            // Not part of the query, it's probably an update
            var upcache = this.cachedUpd[path];
            if (!upcache) {
                upcache = [];
                this.cachedUpd[path] = upcache;
            }
            upcache.push({p:path, v:val, n:prog, e:extra});
        } else if (extra.aft) {
            if (this.sent[extra.aft]) {
                this.forward(path, val, prog, extra);
            } else {
                dbgBroker("Caching %s cause %s not yet sent", path, extra.aft);
                this.cached[extra.aft] = {p:path, v:val, n:prog, e:extra};
            }
        } else {
            this.forward(path, val, prog, extra);
        }
    }

    forward(path :string, val :any, prog :number, extra? :any) :void {
        this.sent[path] = true;
        super.sendValue(path, val, prog, extra);

        var upcache = this.cachedUpd[path];
        if (upcache) {
            dbgBroker("Sending cached updates to %s", path);
            for (var i = 0; i < upcache.length; i++) {
                var incache = upcache[i];
                super.sendValue(incache.p, incache.v, incache.n, incache.e);
            }
        }

        incache = this.cached[path];
        if (!incache) return;

        delete this.cached[path];
        dbgBroker("Sending %s cause %s now is sent", incache.p, path);
        this.forward(incache.p, incache.v, incache.n, incache.e);
    }

    stopSorting() {
        dbgBroker("Stop sorting and flushing cache")
        // Flush anything still in cache
        var ks = Object.getOwnPropertyNames(this.cached);
        for (var i = 0; i < ks.length; i++) {
            var k = ks[i];
            var incache = this.cached[k];
            if (!incache) continue;
            delete this.cached[k];
            this.forward(incache.p, incache.v, incache.n, incache.e);
        }
        // Clear cache and sent
        this.cached = null;
        this.cachedUpd = null;
        this.sent = null;
        this.sorting = false;
    }
}

export interface SimpleQueryEntry {
    path :string;
    value :string;
}

export class SimpleQueryState implements Subscriber {
    def :SimpleQueryDef;
    /**
     * path->sort value
     */
    invalues :SimpleQueryEntry[] = [];
    handler :Handler;
    broker :Broker;

    closed :boolean = false;

    private forwarder :SortAwareForwardingSubscriber = null;
    private _pathRegex :RegExp = null;

    private fetchingCnt = 0;
    private fetchEnded = false;

    constructor(handler :Handler, broker :Broker, def :SimpleQueryDef) {
        this.handler = handler;
        this.broker = broker;
        this.def = def;
        this.forwarder = new SortAwareForwardingSubscriber(this.id + "fwd", this, this.handler);
    }

    get id() {
        return this.def.id;
    }

    get pathRegex() {
        if (!this._pathRegex) {
            var def = this.def;

            // Limit to the path, and if needed subpath
            var subp :string = null;
            if (def.compareField) {
                subp = Utils.parentPath(def.compareField);
            }
            subp = subp || '';
            dbgBroker("Subpath %s", subp);

            var path = def.path;

            this._pathRegex = Utils.pathRegexp(path, subp);
        }
        return this._pathRegex;
    }

    positionFor(val :string) :number {
        for (var i = 0; i < this.invalues.length; i++) {
            if (this.invalues[i].value > val) return i;
        }
        return this.invalues.length;
    }

    /**
     * Start the query, subscribing where needed
     */
    start() {
        this.broker.query(this);
        this.broker.subscribe(this, this.def.path);
    }

    stop() {
        this.closed = true;
        this.broker.unsubscribe(this, this.def.path);
        for (var k in this.invalues) {
            this.broker.unsubscribe(this, k);
            this.broker.unsubscribe(this.forwarder, k);
        }
    }

    found(path :string, data :any) {
        var ind = this.invalues.length;
        var eleVal :any = null;
        if (this.def.compareField) {
            eleVal = data[Utils.leafPath(this.def.compareField)];
        } else {
            eleVal = Utils.leafPath(path);
        }
        ind = this.positionFor(eleVal);
        //dbgBroker("For element %s the sort value is %s and the position %s", path, eleVal, ind);
        var prePath :string = null;
        if (ind) prePath = this.invalues[ind-1].path;
        this.invalues.splice(ind,0,{path:path,value:eleVal});
        this.fetchingCnt++;
        this.broker.subscribe(this.forwarder, path);
        this.broker.fetch(this.forwarder, path, {q:this.id, aft:prePath}).then(()=>{
            this.fetchingCnt--;
            this.checkEnd();
        });
    }

    exited(path :string, ind? :number) {
        this.handler.queryExit(path, this.id);
        this.broker.unsubscribe(this.forwarder, path);
        if (typeof(ind) == 'undefined') {
            for (var i = 0; i < this.invalues.length; i++) {
                if (this.invalues[i].path == path) {
                    ind = i;
                    break;
                }
            }
        }
        this.invalues.splice(ind,1);
    }

    foundEnd() {
        this.fetchEnded = true;
        this.checkEnd();
    }

    checkEnd() {
        if (this.fetchingCnt == 0 && this.fetchEnded) {
            this.forwarder.stopSorting();
            this.handler.queryFetchEnd(this.id);
        }
    }


    checkExit(path :string) {
        for (var i = 0; i < this.invalues.length; i++) {
            if (this.invalues[i].path == path) {
                this.exited(path,i);
                return;
            }
        }
    }

    sendValue(path :string, val :any, prog :number, extra? :any) :void {
        var extra :any = {};
        [path,val] = Utils.normalizeUpdatedValue(path,val);

        if (path.indexOf(this.def.path) == 0) {
            // A direct child has been nulled, check if exited
            if (val == null) {
                dbgQuery("%s : Path %s is reported null", this.id, path);
                return this.checkExit(path);
            }
        }

        dbgQuery("%s : Evaluating %s from modifications in %s in %s", this.id, path, val, this.pathRegex);
        // Check if this makes a difference for the query in-out, find the value of the compareField
        if (path.match(this.pathRegex)) {
            dbgQuery("Matched");
            if (this.def.compareField) {
                var eleVal = val[Utils.leafPath(this.def.compareField)];
            } else {
                eleVal = Utils.leafPath(path);
            }
            // Check if the value is in the acceptable range
            if (typeof(this.def.equals) !== 'undefined') {
                if (this.def.equals != eleVal) return this.checkExit(path);
            } else if (typeof(this.def.from) !== 'undefined') {
                if (eleVal < this.def.from) return this.checkExit(path);
            } else if (typeof(this.def.to) !== 'undefined') {
                if (eleVal > this.def.to) return this.checkExit(path);
            }
            var pos = this.positionFor(eleVal);
            if (this.def.limit) {
                // If the position is over the limit we can discard this
                if (pos >= this.def.limit) return this.checkExit(path);
            }
            // We have a new value to insert
            this.invalues.splice(pos,0,{path:path,value:eleVal});
            var prePath :string = null;
            if (pos) prePath = this.invalues[pos-1].path;
            this.broker.fetch(this.forwarder, path, {q:this.id, aft:prePath});

            if (this.def.limit) {
                // Check who went out
                var ele = this.invalues[this.invalues.length-1];
                this.exited(ele.path, this.invalues.length);
            } 
        }
    }

}

function filterAck(fn :Function, val :any) {
    if (!fn || typeof fn !== 'function') return;
    fn(val);
}

// Does not need to export, but there are no friendly/package/module accessible methods, and Broker.subscribe will complain is Handler is private
export class Handler implements Subscriber {

    id = 'na';
    closed = false;
    private pathSubs :{[index:string]:boolean} = {};
    private queries :{[index:string]:SimpleQueryState} = {};

    private ongoingReads :{[index:string]:boolean} = {};
    private ongoingWrite :Function = null;
    private writeQueue :Function[] = [];
    private readQueue :Function[] = [];

    public writeProg = 1;

    // TODO a read-write lock that avoids sending to the client stale data.
    /*
     Approximate rules should be :
        - When a read arrive
            - If a write is in progress or in queue, store the read in a queue
            - Start the read, count number of ongoing reads
        - When a write arrive
            - If reads or writes are in progress, store the write in a queue
        - When there are no ongoing reads, dequeue one at a time the write operations
        - Where there are no ongoing writes, start simultaneously all the read operations
     */



 
    constructor(
        private socket :Socket,
        private authData :Object,
        private broker :Broker
    ) {
        this.id = socket.id.substr(2);
        dbgHandler("%s handler created", this.id);

        socket.on('sp', (path:string,fn:Function)=>this.enqueueRead(()=>filterAck(fn,this.subscribePath(path))));
        socket.on('up', (path:string,fn:Function)=>filterAck(fn,this.unsubscribePath(path)));
        socket.on('pi', (writeProg:number,fn:Function)=>filterAck(fn,this.ping(writeProg)));

        socket.on('sq', (def:SimpleQueryDef,fn:Function)=>this.enqueueRead(()=>filterAck(fn,this.subscribeQuery(def))));
        socket.on('uq', (id:string,fn:Function)=>filterAck(fn,this.unsubscribeQuery(id)));
        
        socket.on('s', (path:string, val :any, prog :number, fn:Function)=>this.enqueueWrite(()=>this.set(path,val,prog, fn)));
        socket.on('m', (path:string, val :any, prog :number,fn:Function)=>this.enqueueWrite(()=>this.merge(path,val,prog, fn)));

        socket.on('disconnect', ()=>{
            this.close();
        });

        broker.register(this);

        socket.emit('aa');
        socket.on('aa', ()=>{socket.emit('aa')});
    }

    private enqueueRead(fn :Function) {
        // If no write operation in the queue (waiting or executing) fire the read
        if (this.writeQueue.length == 0) return fn();
        // Otherwise queue the read
        this.readQueue.push(fn);

        dbgHandler("%s enqueued read operation, now %s in queue", this.id, this.readQueue.length);
    }

    private enqueueWrite(fn :Function) {
        // Anyway put the write in the queue
        this.writeQueue.push(fn);

        dbgHandler("%s enqueued write operation, now %s in queue", this.id, this.writeQueue.length);

        this.dequeue();
    }

    private dequeue() {
        // If there is something in the write queue, fire it
        if (this.writeQueue.length) {
            // If there are no reads going on
            for (var k in this.ongoingReads) return;
            // If there is no write already going on 
            if (this.ongoingWrite) return;
            // Fire the write
            dbgHandler("%s dequeuing write operation", this.id);
            this.ongoingWrite = this.writeQueue.shift();
            this.ongoingWrite();
            return;
        }
        // Otherwise fire all reads
        var readfn :Function = null;
        while ((readfn = this.readQueue.pop())) {
            dbgHandler("%s dequeuing write operation", this.id);
            readfn();
        }
    }


    updateAuthData(data :any) {
        this.authData = data;
    }

    close() {
        dbgHandler("%s closing handler", this.id);
        if (this.closed) return;
        this.closed = true;
        this.socket.removeAllListeners();
        this.readQueue = null;
        this.writeQueue = null;
        this.socket = null;

        for (var k in this.pathSubs) {
            this.broker.unsubscribe(this,k);
        }
        for (var k in this.queries) {
            this.queries[k].stop();
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
        this.ongoingReads[path] = true;
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
        delete this.ongoingReads[path];
        this.broker.unsubscribe(this, path);
        return 'k';
    }

    subscribeQuery(def :SimpleQueryDef) {
        if (this.queries[def.id]) {
            dbgHandler("%s was already subscribed to query %s", this.id, def.id);
            return 'k';
        }
        dbgHandler("%s subscribing query to %s", this.id, def.path);
        this.ongoingReads['$q' + def.id] = true;
        var state = new SimpleQueryState(this, this.broker, def);
        this.queries[def.id] = state;
        state.start();
        return 'k';
    }

    unsubscribeQuery(id :string) {
        var state = this.queries[id];
        if (!state) {
            dbgHandler("%s was already unsubscribed from query %s", this.id, id);
            return 'k';
        }
        dbgHandler("%s unsubscribing from query %s", this.id, id);
        state.stop();
        delete this.ongoingReads['$q' + id];
        delete this.queries[id];
        return 'k';
    }

    ping(writeProg :number) :number {
        dbgHandler("%s received ping %s", this.id, writeProg);
        this.writeProg = writeProg;
        return writeProg;
    }

    set(path :string, val :any, prog :number, cb :Function) {
        dbgHandler("%s writing prog %s in %s %o", this.id, prog, path, val);
        this.writeProg = Math.max(this.writeProg, prog);
        // TODO security here
        this.broker.set(this, path, val)
        .then(()=>{
            this.ongoingWrite = null;
            this.dequeue();
            filterAck(cb,'k');
        })
        .catch((e)=>{
            this.ongoingWrite = null;
            this.dequeue();
            dbgHandler("Got error", e);
            filterAck(cb,e.message);
        });
    }

    merge(path :string, val :any, prog :number, cb :Function) {
        dbgHandler("%s merging prog %s in %s %o", this.id, prog, path, val);
        this.writeProg = Math.max(this.writeProg, prog);
        // TODO security here
        this.broker.merge(this, path, val)
        .then(()=>{
            this.ongoingWrite = null;
            this.dequeue();
            filterAck(cb,'k');
        })
        .catch((e)=>{
            this.ongoingWrite = null;
            this.dequeue();
            dbgHandler("Got error", e);
            filterAck(cb,e.message);
        });
    }

    sendValue(path :string, val :any, prog :number, extra? :any) {
        if (this.closed) return;
        // TODO evaluate query matching
        // TODO security filter here?
        var msg :any = {p:path,v:val, n:prog};
        for (var k in extra) {
            msg[k] = extra[k];
        }
        dbgHandler("%s sending value %o", this.id, msg);
        this.socket.emit('v', msg);
        if (!extra || !extra.q) {
            delete this.ongoingReads[path];
            this.dequeue();
        }
    }

    queryFetchEnd(queryId :string) {
        if (this.closed) return;
        dbgHandler("%s sending query end %s", this.id, queryId);
        this.socket.emit('qd', {q:queryId});
        delete this.ongoingReads['$q' + queryId];
        this.dequeue();
    }

    queryExit(path :string, queryId :string) {
        if (this.closed) return;
        dbgHandler("%s sending query exit %s:%s", this.id, queryId, path);
        this.socket.emit('qx', {q:queryId, p: path, n:this.writeProg});
    }
}

export class Recomposer {
    base :string;

    refs :{[index:string]:any} = {};

    constructor(base :string) {
        this.base = Utils.normalizePath(base);
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
        var par = Utils.parentPath(path);
        var lst = Utils.leafPath(path);
        var preobj :any = {};
        preobj[lst] = acref;
        this.findOrCreateRefFor(par, preobj);
    }
}


var hasOwnProperty = Object.prototype.hasOwnProperty;

var socketcnt = 1;
export class LocalSocket {
    server :Socket;
    client :Socket;

    constructor() {
        var a = new InternalSocket();
        var b = new InternalSocket();
        a.other = b;
        b.other = a;
        
        b.id = 'local' + (socketcnt++);
        a.id = '#/' + b.id;

        a.role = 'SRV';
        b.role = 'CLN';
         
        this.server = a;
        this.client = b;
    }
}

class InternalSocket extends EventEmitter implements Socket {
    id :string;
    role :string;
    other :InternalSocket;

    constructor() {
        super();
    }
    
    emit(name :string, ...args :any[]) :boolean {
        var lstnrs = this.other.listeners(name);
        var val :any;
        // Add a do-nothing callback, in case the listener expects it but the emitter didn't provide a real one
        args.push(()=>{});
        for (var i = 0; i < lstnrs.length; i++) {
            try {
                val = lstnrs[i].apply(this, args);
            } catch (e) {
                dbgSocket('Internal socket emit %s error %o', name, e);
            }
        }
        return !!lstnrs.length;
    }

}