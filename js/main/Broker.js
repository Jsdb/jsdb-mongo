(function (factory) {
    if (typeof module === 'object' && typeof module.exports === 'object') {
        var v = factory(require, exports); if (v !== undefined) module.exports = v;
    }
    else if (typeof define === 'function' && define.amd) {
        define(["require", "exports", 'mongodb', 'debug'], factory);
    }
})(function (require, exports) {
    "use strict";
    var Mongo = require('mongodb');
    var Debug = require('debug');
    var dbgBroker = Debug('tsdb:mongo:broker');
    var dbgOplog = Debug('tsdb:mongo:oplog');
    var dbgSocket = Debug('tsdb:mongo:socket');
    var dbgHandler = Debug('tsdb:mongo:handler');
    var NopAuthService = (function () {
        function NopAuthService() {
        }
        NopAuthService.prototype.authenticate = function (socket) {
            return Promise.resolve({});
        };
        return NopAuthService;
    }());
    var progHandler = 0;
    var Broker = (function () {
        function Broker($socket, collectionDb, collectionName, oplogDb, collectionOptions) {
            this.id = progHandler++;
            this.auth = new NopAuthService();
            this.started = false;
            this.closed = false;
            this.startWait = [];
            this.handlers = {};
            this.subscriptions = {};
            dbgBroker("Created broker %s", this.id);
            this.socket = $socket;
            if (collectionDb && collectionName) {
                this.initCollection(collectionDb, collectionName, collectionOptions);
            }
            if (oplogDb) {
                this.initOplog(oplogDb);
            }
        }
        Broker.prototype.setSocket = function (value) {
            if (this.started)
                throw new Error("Cannot change the socket on an already started broker");
            this.socket = value;
            return this;
        };
        Broker.prototype.setCollection = function (value) {
            if (this.started)
                throw new Error("Cannot change the collection on an already started broker");
            this.collection = value;
            this.collectionNs = this.collection.namespace;
            return this;
        };
        Broker.prototype.setOplogDb = function (value) {
            if (this.started)
                throw new Error("Cannot change the oplog db on an already started broker");
            this.oplogDb = value;
            this.oplog = this.oplogDb.collection('oplog.rs');
            return this;
        };
        Broker.prototype.initCollection = function (collectionDb, collectionName, collectionOptions) {
            var _this = this;
            if (this.started)
                throw new Error("Cannot change the collection on an already started broker");
            this.startWait.push(Mongo.MongoClient.connect(collectionDb, collectionOptions).then(function (db) {
                _this.collectionDb = db;
                _this.collection = _this.collectionDb.collection(collectionName);
            }));
            return this;
        };
        Broker.prototype.initOplog = function (oplogDb) {
            var _this = this;
            if (this.started)
                throw new Error("Cannot change the oplog on an already started broker");
            this.startWait.push(Mongo.MongoClient.connect(oplogDb).then(function (db) {
                _this.oplogDb = db;
                _this.oplog = _this.oplogDb.collection('oplog.rs');
            }));
            return this;
        };
        Broker.prototype.setAuthService = function (value) {
            if (this.started)
                throw new Error("Cannot change the auth service on an already started broker");
            this.auth = value;
            return this;
        };
        Broker.prototype.start = function () {
            var _this = this;
            if (this.closed)
                throw new Error("Cannot restart and already closed broker");
            if (this.started) {
                dbgBroker("Broker was already started");
                return;
            }
            dbgBroker("Starting broker, waiting " + this.startWait.length + " promises to complete");
            this.started = true;
            // Wait for connections to be made
            return Promise.all(this.startWait).then(function () {
                dbgBroker("Hooking on socket");
                // Hook the socket
                _this.socket.on('connect', function (sock) {
                    if (_this.closed)
                        return;
                    dbgSocket("Got connection %s from %s", sock.id, sock.client.conn.remoteAddress);
                    _this.auth.authenticate(sock).then(function (authData) {
                        dbgSocket("Authenticated %s with data %o", sock.id, authData);
                        // Create a handler for this connection
                        var handler = new Handler(sock, authData, _this);
                    });
                });
                // Hook the oplog
                dbgBroker("Hooking on oplog");
                return _this.hookOplog();
            });
        };
        Broker.prototype.hookOplog = function () {
            var _this = this;
            if (!this.oplog)
                return;
            if (this.closed)
                return;
            return this.oplog.find({}).project({ ts: 1 }).sort({ $natural: -1 }).limit(1).toArray().then(function (max) {
                if (_this.closed)
                    return;
                var maxtime = new Mongo.Timestamp(0, Math.floor(new Date().getTime() / 1000));
                if (max && max.length && max[0].ts)
                    maxtime = max[0].ts;
                var oplogStream = _this.oplog
                    .find({ ts: { $gt: maxtime } })
                    .project({ op: 1, o: 1, o2: 1 })
                    .addCursorFlag('tailable', true)
                    .addCursorFlag('awaitData', true)
                    .addCursorFlag('oplogReplay', true)
                    .setCursorOption('numberOfRetries', -1)
                    .stream();
                oplogStream.on('data', function (d) {
                    // Find and notify registered handlers
                    dbgOplog('%s : %o', _this.id, d);
                    if (d.op == 'i') {
                        // It's an insert of new data
                        _this.broadcast(d.o._id, d.o);
                    }
                    else if (d.op == 'u') {
                        // Update of leaf data(s)
                        var dset = d.o.$set;
                        for (var k in dset) {
                            _this.broadcast(d.o2._id + '/' + k, dset[k]);
                        }
                        dset = d.o.$unset;
                        for (var k in dset) {
                            _this.broadcast(d.o2._id + '/' + k, null);
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
                            _this.broadcast(d.o2._id, updo);
                        }
                    }
                    else if (d.op == 'd') {
                        // Parse and broadcast the delete
                        _this.broadcast(d.o._id, null);
                    }
                });
                oplogStream.on('close', function () {
                    // Re-hook
                    if (_this.closed)
                        return;
                    dbgBroker("Re-hooking on oplog after a close event");
                    _this.hookOplog();
                });
                oplogStream.on('error', function (e) {
                    // Re-hook
                    dbgBroker("Re-hooking on oplog after error", e);
                    _this.hookOplog();
                });
                _this.lastOplogStream = oplogStream;
            });
        };
        Broker.prototype.register = function (handler) {
            this.handlers[handler.id] = handler;
        };
        Broker.prototype.unregister = function (handler) {
            delete this.handlers[handler.id];
        };
        Broker.prototype.subscribe = function (handler, path) {
            path = Broker.normalizePath(path);
            var ps = this.subscriptions[path];
            if (!ps) {
                this.subscriptions[path] = ps = {};
            }
            ps[handler.id] = handler;
        };
        Broker.prototype.unsubscribe = function (handler, path) {
            path = Broker.normalizePath(path);
            var ps = this.subscriptions[path];
            if (!ps)
                return;
            delete ps[handler.id];
            for (var key in ps) {
                if (hasOwnProperty.call(ps, key))
                    return;
            }
            delete this.subscriptions[path];
        };
        Broker.prototype.broadcast = function (path, val) {
            var alreadySent = {};
            this.broadcastDown(path, val, alreadySent);
            this.broadcastUp(Broker.parentPath(path), val, path, alreadySent);
        };
        Broker.prototype.broadcastDown = function (path, val, alreadySent) {
            if (val == null) {
                for (var k in this.subscriptions) {
                    if (k.indexOf(path) == 0) {
                        this.broadcastToHandlers(k, null, alreadySent);
                    }
                }
            }
            if (typeof (val) == 'object' || typeof (val) == 'function') {
                for (var k in val) {
                    this.broadcastDown(path + '/' + k, val[k], alreadySent);
                }
            }
            this.broadcastToHandlers(path, val, alreadySent);
        };
        Broker.prototype.broadcastUp = function (path, val, fullpath, alreadySent) {
            this.broadcastToHandlers(path, val, alreadySent, fullpath);
            if (path.length == 0)
                return;
            path = Broker.parentPath(path);
            this.broadcastUp(path, val, fullpath, alreadySent);
        };
        Broker.prototype.broadcastToHandlers = function (path, val, alreadySent, fullpath) {
            var ps = this.subscriptions[path];
            if (!ps)
                return;
            var tspath = fullpath || path;
            for (var k in ps) {
                if (alreadySent[k])
                    continue;
                var handler = ps[k];
                // TODO sending only one event is not that simple, the event should be the right one, at the right depth in the tree
                //alreadySent[k] = handler; 
                if (handler.closed) {
                    delete ps[k];
                    continue;
                }
                handler.sendValue(tspath, val);
            }
        };
        Broker.prototype.close = function () {
            if (!this.started)
                return;
            if (this.closed) {
                dbgBroker("Closing already closed broker %s", this.id);
                return;
            }
            dbgBroker("Closing broker %s", this.id);
            // Sttings closed to true will stop re-hooking the oplog and handing incoming socket connections
            this.closed = true;
            var proms = [];
            if (this.lastOplogStream) {
                proms.push(this.lastOplogStream.close());
            }
            var handlerKeys = Object.getOwnPropertyNames(this.handlers);
            for (var i = 0; i < handlerKeys.length; i++) {
                var handler = this.handlers[handlerKeys[i]];
                if (handler)
                    handler.close();
            }
            return Promise.all(proms);
        };
        Broker.normalizePath = function (path) {
            path = path.replace(/\/\.+\//g, '/');
            path = path.replace(/\/\/+/g, '/');
            if (path.charAt(0) != '/')
                path = '/' + path;
            if (path.charAt(path.length - 1) == '/')
                path = path.substr(0, path.length - 1);
            return path;
        };
        Broker.leafPath = function (path) {
            return path.substr(path.lastIndexOf('/') + 1);
        };
        Broker.parentPath = function (path) {
            return path.substr(0, path.lastIndexOf('/'));
        };
        Broker.pathRegexp = function (path) {
            path = path.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
            return new RegExp('^' + path + '.*');
        };
        Broker.prototype.del = function (handler, paths) {
            var ops = [];
            for (var i = 0; i < paths.length; i++) {
                ops[i] = {
                    deleteMany: {
                        filter: {
                            _id: Broker.pathRegexp(paths[i])
                        }
                    }
                };
            }
            return this.collection.bulkWrite(ops);
        };
        Broker.prototype.set = function (handler, path, val) {
            var _this = this;
            path = Broker.normalizePath(path);
            if (val === null) {
                var leaf = Broker.leafPath(path);
                if (!leaf)
                    throw new Error('Cannot write a primitive value on root');
                var par = Broker.parentPath(path);
                dbgBroker("Unsetting %s -> %s", par, leaf);
                var obj = {};
                obj[leaf] = 1;
                return Promise.all([
                    this.del(handler, [path]),
                    this.collection.updateOne({ _id: par }, { $unset: obj })
                ]);
            }
            if (typeof val == 'string' || typeof val == 'number' || typeof val == 'boolean') {
                // Saving a primitive value
                var leaf = Broker.leafPath(path);
                if (!leaf)
                    throw new Error('Cannot write a primitive value on root');
                var par = Broker.parentPath(path);
                dbgBroker("Setting %s -> %s = %s", par, leaf, val);
                var obj = {};
                obj[leaf] = val;
                return Promise.all([
                    this.del(handler, [path]),
                    this.collection.updateOne({ _id: par }, { $set: obj }, { upsert: true })
                ]);
            }
            return this.collection.find({ _id: Broker.pathRegexp(path) }).sort({ _id: 1 }).toArray().then(function (pres) {
                var premap = {};
                for (var i = 0; i < pres.length; i++) {
                    var pre = pres[i];
                    premap[pre._id] = pre;
                }
                // Saving a complex object
                var unrolled = [];
                var deletes = [];
                _this.recursiveUnroll(path, val, unrolled, deletes);
                if (unrolled.length == 0) {
                    dbgBroker("Nothing to write in path %s with val %o", path, val);
                    return Promise.resolve();
                }
                var ops = [];
                for (var i = 0; i < unrolled.length; i++) {
                    delete premap[unrolled[i]._id];
                    ops[i] = {
                        updateOne: {
                            filter: { _id: unrolled[i]._id },
                            update: unrolled[i],
                            upsert: true
                        }
                    };
                }
                var delpaths = [];
                for (var k in premap) {
                    delpaths.push(k);
                }
                _this.del(handler, delpaths);
                dbgBroker("For %s writing %s updates and %s delete operations in path %s with val %o", handler.id, ops.length, delpaths.length, path, val);
                return _this.collection.bulkWrite(ops);
            });
        };
        Broker.prototype.recursiveUnroll = function (path, val, writes, dels) {
            if (writes === void 0) { writes = []; }
            if (dels === void 0) { dels = []; }
            var myobj = {
                _id: path
            };
            var atlo = false;
            for (var k in val) {
                var subv = val[k];
                if (typeof (subv) == 'function' || typeof (subv) == 'object') {
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
        };
        Broker.prototype.fetch = function (handler, path) {
            var _this = this;
            dbgBroker('Fetching %s for %s', path, handler.id);
            path = Broker.normalizePath(path);
            this.collection
                .find({ _id: Broker.pathRegexp(path) }).sort({ _id: 1 })
                .toArray()
                .then(function (data) {
                if (data.length != 0) {
                    dbgBroker("Found %s bag objects to recompose", data.length);
                    _this.stream(handler, path, data);
                    return;
                }
                _this.collection.findOne({ _id: Broker.parentPath(path) }).then(function (val) {
                    if (val == null) {
                        dbgBroker("Found no value on parent path");
                        handler.sendValue(path, null);
                    }
                    else {
                        var leaf = Broker.leafPath(path);
                        dbgBroker("Found %s on parent path", val[leaf]);
                        handler.sendValue(path, val[leaf]);
                    }
                });
            })
                .catch(function (e) {
                dbgBroker("Had error %s", e);
                // TODO handle this errors differently
            });
        };
        Broker.prototype.stream = function (handler, path, data) {
            // recompose the object and send it
            var recomposer = new Recomposer(path);
            for (var i = 0; i < data.length; i++) {
                recomposer.add(data[i]);
            }
            handler.sendValue(path, recomposer.get());
        };
        return Broker;
    }());
    exports.Broker = Broker;
    // Does not need to export, but there are no friendly/package/module accessible methods, and Broker.subscribe will complain is Handler is private
    var Handler = (function () {
        function Handler(socket, authData, broker) {
            var _this = this;
            this.socket = socket;
            this.authData = authData;
            this.broker = broker;
            this.id = 'na';
            this.closed = false;
            this.pathSubs = {};
            this.id = socket.id.substr(2);
            socket.on('sp', function (path, fn) { return fn(_this.subscribePath(path)); });
            socket.on('up', function (path, fn) { return fn(_this.unsubscribePath(path)); });
            socket.on('pi', function (id, fn) { return fn(_this.ping(id)); });
            socket.on('s', function (path, val, fn) { return _this.set(path, val, fn); });
            socket.on('disconnect', function () {
                _this.close();
            });
            broker.register(this);
            socket.emit('aa');
        }
        Handler.prototype.close = function () {
            dbgHandler("%s closing handler", this.id);
            if (this.closed)
                return;
            this.closed = true;
            this.socket.removeAllListeners();
            this.socket = null;
            for (var k in this.pathSubs) {
                this.broker.unsubscribe(this, k);
            }
            // TODO stop ongoing fetch operations?
            this.broker.unregister(this);
            this.broker = null;
            this.authData = null;
        };
        Handler.prototype.subscribePath = function (path) {
            if (this.pathSubs[path]) {
                dbgHandler("%s was already subscribed to %s", this.id, path);
                return 'k';
            }
            dbgHandler("%s subscribing to %s", this.id, path);
            this.pathSubs[path] = true;
            this.broker.subscribe(this, path);
            this.broker.fetch(this, path);
            return 'k';
        };
        Handler.prototype.unsubscribePath = function (path) {
            if (!this.pathSubs[path]) {
                dbgHandler("%s was already unsubscribed from %s", this.id, path);
                return 'k';
            }
            dbgHandler("%s unsubscribing from %s", this.id, path);
            delete this.pathSubs[path];
            this.broker.unsubscribe(this, path);
            return 'k';
        };
        Handler.prototype.ping = function (id) {
            dbgHandler("%s received ping %s", this.id, id);
            return id;
        };
        Handler.prototype.set = function (path, val, cb) {
            dbgHandler("%s writing in %s %o", this.id, path, val);
            // TODO security here
            this.broker.set(this, path, val).then(function () { return cb('k'); }).catch(function (e) {
                dbgHandler("Got error", e);
                // TODO how to handle errors?
            });
        };
        Handler.prototype.sendValue = function (path, val) {
            // TODO security filter here?
            this.socket.emit('v', { p: path, v: val });
        };
        return Handler;
    }());
    exports.Handler = Handler;
    var Recomposer = (function () {
        function Recomposer(base) {
            this.refs = {};
            this.base = Broker.normalizePath(base);
        }
        Recomposer.prototype.add = function (obj) {
            var path = obj._id;
            this.findOrCreateRefFor(path, obj);
        };
        Recomposer.prototype.get = function () {
            return this.refs[this.base];
        };
        Recomposer.prototype.findOrCreateRefFor = function (path, obj) {
            if (obj._id)
                delete obj._id;
            var acref = this.refs[path];
            if (acref) {
                if (obj) {
                    for (var k in obj) {
                        acref[k] = obj[k];
                    }
                }
            }
            else {
                acref = obj;
                this.refs[path] = acref;
            }
            if (path == this.base)
                return;
            var par = Broker.parentPath(path);
            var lst = Broker.leafPath(path);
            var preobj = {};
            preobj[lst] = acref;
            this.findOrCreateRefFor(par, preobj);
        };
        return Recomposer;
    }());
    exports.Recomposer = Recomposer;
    var hasOwnProperty = Object.prototype.hasOwnProperty;
});

//# sourceMappingURL=Broker.js.map
