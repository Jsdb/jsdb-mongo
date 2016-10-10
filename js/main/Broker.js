/**
 * TSDB Mongo 20161010_030723_master_1.0.0_faa0c66
 */
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
(function (factory) {
    if (typeof module === 'object' && typeof module.exports === 'object') {
        var v = factory(require, exports); if (v !== undefined) module.exports = v;
    }
    else if (typeof define === 'function' && define.amd) {
        define(["require", "exports", 'mongodb', 'debug', './Utils', 'events'], factory);
    }
})(function (require, exports) {
    "use strict";
    var Mongo = require('mongodb');
    var Debug = require('debug');
    var Utils = require('./Utils');
    var events_1 = require('events');
    var dbgBroker = Debug('tsdb:mongo:broker');
    var dbgDbConn = Debug('tsdb:mongo:dbconnection');
    var dbgQuery = Debug('tsdb:mongo:query');
    var dbgOplog = Debug('tsdb:mongo:oplog');
    var dbgSocket = Debug('tsdb:mongo:socket');
    var dbgHandler = Debug('tsdb:mongo:handler');
    exports.VERSION = "20161010_030723_master_1.0.0_faa0c66";
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
            this.oplogMaxtime = null;
            this.oplogStream = null;
            //(<any>Mongo).Logger.setLevel('debug');
            dbgBroker("Created broker %s", this.id);
            this.socket = $socket;
            if (collectionDb && collectionName) {
                this.initCollection(collectionDb, collectionName, collectionOptions);
            }
            if (oplogDb) {
                this.initOplog(oplogDb);
            }
        }
        Broker.prototype.setSocketServer = function (value) {
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
            if (collectionOptions === void 0) { collectionOptions = { db: { bufferMaxEntries: 5 } }; }
            if (this.started)
                throw new Error("Cannot change the collection on an already started broker");
            dbgBroker("Connecting to collection on url %s collection %s options %o", collectionDb, collectionName, collectionOptions);
            this.startWait.push(Mongo.MongoClient.connect(collectionDb, collectionOptions).then(function (db) {
                dbgBroker("Connected to db, opening %s collection", collectionName);
                _this.collectionDb = db;
                _this.collection = _this.collectionDb.collection(collectionName);
            }).then(function () {
                dbgBroker("Connected to collection");
            }).catch(function (err) {
                console.warn("Error opening collection connection", err);
                return Promise.reject(err);
            }));
            return this;
        };
        Broker.prototype.initOplog = function (oplogDb) {
            var _this = this;
            if (this.started)
                throw new Error("Cannot change the oplog on an already started broker");
            dbgBroker("Connecting oplog %s", oplogDb);
            this.startWait.push(Mongo.MongoClient.connect(oplogDb, { db: { bufferMaxEntries: 5 } }).then(function (db) {
                dbgBroker("Connected to db, opening oplog.rs collection");
                _this.oplogDb = db;
                _this.oplog = _this.oplogDb.collection('oplog.rs');
            }).then(function () {
                dbgBroker("Connected to oplog");
            }).catch(function (err) {
                console.warn("Error opening oplog connection", err);
                return Promise.reject(err);
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
                if (_this.socket) {
                    dbgBroker("Hooking on socket");
                    // Hook the socket
                    _this.socket.on('connect', function (sock) {
                        if (_this.closed)
                            return;
                        dbgSocket("Got connection %s from %s", sock.id, sock.client.conn.remoteAddress);
                        _this.auth.authenticate(sock, null).then(function (authData) {
                            dbgSocket("Authenticated %s with data %o", sock.id, authData);
                            // Create a handler for this connection
                            _this.handle(sock, authData);
                        });
                    });
                }
                // Hook the oplog
                dbgBroker("Hooking on oplog");
                return _this.hookOplog();
            });
        };
        Broker.prototype.handle = function (sock, authData) {
            var _this = this;
            var handler = new Handler(sock, authData, this);
            sock.on('auth', function (data) {
                _this.auth.authenticate(sock, data).then(function (authData) {
                    handler.updateAuthData(authData);
                });
            });
            return handler;
        };
        Broker.prototype.hookOplog = function () {
            var _this = this;
            if (!this.oplog)
                return;
            if (this.closed)
                return;
            var findMaxProm = null;
            if (!this.oplogMaxtime) {
                dbgBroker("Connecting oplog, looking for maxtime");
                findMaxProm = this.oplog.find({}).project({ ts: 1 }).sort({ $natural: -1 }).limit(1).toArray().then(function (max) {
                    var maxtime = new Mongo.Timestamp(0, Math.floor(new Date().getTime() / 1000));
                    if (max && max.length && max[0].ts)
                        maxtime = max[0].ts;
                    _this.oplogMaxtime = maxtime;
                    return maxtime;
                });
            }
            else {
                findMaxProm = Promise.resolve(this.oplogMaxtime);
            }
            return findMaxProm.then(function (maxtime) {
                if (_this.closed)
                    return;
                dbgBroker("Connecting oplog");
                if (_this.oplogStream) {
                    var oldstream = _this.oplogStream;
                    _this.oplogStream = null;
                    oldstream.close();
                }
                var oplogStream = _this.oplogStream = _this.oplog
                    .find({ ts: { $gt: maxtime } })
                    .project({ op: 1, o: 1, o2: 1, ts: 1 })
                    .addCursorFlag('tailable', true)
                    .addCursorFlag('awaitData', true)
                    .addCursorFlag('oplogReplay', true)
                    .setCursorOption('numberOfRetries', -1)
                    .stream();
                oplogStream.on('data', function (d) {
                    // Find and notify registered handlers
                    dbgOplog('%s : %o', _this.id, d);
                    _this.oplogMaxtime = d.ts;
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
                    // Rehooking does not work, mongo tries to connect to the arbiter and gets stuck, in the meanwhile better to restart
                    process.exit(1);
                    if (_this.closed)
                        return;
                    if (_this.oplogStream === oplogStream) {
                        dbgBroker("Re-hooking on oplog after a close event");
                        _this.hookOplog();
                    }
                });
                oplogStream.on('error', function (e) {
                    // Re-hook
                    // Rehooking does not work, mongo tries to connect to the arbiter and gets stuck, in the meanwhile better to restart
                    process.exit(1);
                    dbgBroker("Re-hooking on oplog after error", e);
                    oplogStream.close();
                });
                dbgBroker("Oplog connected");
            }).catch(function (e) {
                dbgBroker("Error connecting to the oplog, will retry in 1 second %o", e);
                setTimeout(function () {
                    _this.hookOplog();
                }, 1000);
            });
        };
        Broker.prototype.register = function (handler) {
            this.handlers[handler.id] = handler;
        };
        Broker.prototype.unregister = function (handler) {
            delete this.handlers[handler.id];
        };
        Broker.prototype.subscribe = function (handler, path) {
            path = Utils.normalizePath(path);
            var ps = this.subscriptions[path];
            if (!ps) {
                this.subscriptions[path] = ps = {};
            }
            ps[handler.id] = handler;
        };
        Broker.prototype.unsubscribe = function (handler, path) {
            path = Utils.normalizePath(path);
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
            this.broadcastUp(Utils.parentPath(path), val, path, alreadySent);
        };
        Broker.prototype.broadcastDown = function (path, val, alreadySent) {
            if (val == null) {
                for (var k in this.subscriptions) {
                    if (k.indexOf(path) == 0) {
                        this.broadcastToHandlers(k, null, alreadySent);
                    }
                }
            }
            else if (typeof (val) == 'object' || typeof (val) == 'function') {
                delete val._id;
                for (var k in val) {
                    this.broadcastDown(path + '/' + k, val[k], alreadySent);
                }
            }
            this.broadcastToHandlers(path, val, alreadySent);
        };
        Broker.prototype.broadcastUp = function (path, val, fullpath, alreadySent) {
            if (!path)
                return;
            if (val && val._id)
                delete val._id;
            this.broadcastToHandlers(path, val, alreadySent, fullpath);
            if (path.length == 0)
                return;
            this.broadcastUp(Utils.parentPath(path), val, fullpath, alreadySent);
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
                handler.sendValue(tspath, val, handler.writeProg);
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
            if (this.oplogStream) {
                proms.push(this.oplogStream.close());
            }
            var handlerKeys = Object.getOwnPropertyNames(this.handlers);
            for (var i = 0; i < handlerKeys.length; i++) {
                var handler = this.handlers[handlerKeys[i]];
                if (handler)
                    handler.close();
            }
            return Promise.all(proms);
        };
        Broker.prototype.del = function (handler, paths) {
            var ops = [];
            for (var i = 0; i < paths.length; i++) {
                ops[i] = {
                    deleteMany: {
                        filter: {
                            _id: Utils.pathRegexp(paths[i])
                        }
                    }
                };
            }
            if (ops.length == 0)
                return Promise.resolve(null);
            return this.collection.bulkWrite(ops);
        };
        Broker.prototype.merge = function (handler, path, val) {
            path = Utils.normalizePath(path);
            var proms = [];
            for (var k in val) {
                if (val[k] == null) {
                    proms.push(this.set(handler, path + '/' + k, null));
                }
                else {
                    proms.push(this.set(handler, path + '/' + k, val[k]));
                }
            }
            return Promise.all(proms);
        };
        Broker.prototype.set = function (handler, path, val) {
            var _this = this;
            path = Utils.normalizePath(path);
            if (val !== null && (typeof val == 'string' || typeof val == 'number' || typeof val == 'boolean')) {
                // Saving a primitive value
                var leaf = Utils.leafPath(path);
                if (!leaf)
                    throw new Error('Cannot write a primitive value on root');
                var par = Utils.parentPath(path);
                dbgBroker("Setting %s -> %s = %s", par, leaf, val);
                var obj = {};
                obj[leaf] = val;
                return Promise.all([
                    this.del(handler, [path]),
                    this.collection.updateOne({ _id: par }, { $set: obj }, { upsert: true })
                ]);
            }
            if (val === null || Utils.isEmpty(val)) {
                var leaf = Utils.leafPath(path);
                //if (!leaf) throw new Error('Cannot write a primitive value on root');
                var par = Utils.parentPath(path);
                dbgBroker("Unsetting %s -> %s", par, leaf);
                var obj = {};
                obj[leaf] = 1;
                return Promise.all([
                    this.del(handler, [path]),
                    this.collection.updateOne({ _id: par }, { $unset: obj })
                ]);
            }
            return this.collection.find({ _id: Utils.pathRegexp(path) }).sort({ _id: 1 }).toArray().then(function (pres) {
                var premap = {};
                for (var i = 0; i < pres.length; i++) {
                    var pre = pres[i];
                    premap[pre._id] = pre;
                }
                // Saving a complex object
                var unrolled = [];
                _this.recursiveUnroll(path, val, unrolled);
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
                dbgBroker("For %s writing %s updates and %s delete operations in path %s with val %s", handler.id, ops.length, delpaths.length, path, JSON.stringify(ops));
                return _this.collection.bulkWrite(ops, { ordered: false }).then(function (res) {
                    var rres = res;
                    if (!rres.hasWriteErrors())
                        return null;
                    throw new Error("Not all requested operations performed correctly : %o " + rres.getWriteErrors());
                });
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
                if (subv == null) {
                    dels.push(path + '/' + k);
                    continue;
                }
                if (typeof (subv) == 'function' || typeof (subv) == 'object') {
                    this.recursiveUnroll(path + '/' + k, subv, writes, dels);
                    continue;
                }
                atlo = true;
                myobj[k] = val[k];
            }
            if (atlo) {
                writes.push(myobj);
            }
        };
        Broker.prototype.fetch = function (handler, path, extra) {
            var _this = this;
            dbgBroker('Fetching %s for %s', path, handler.id);
            path = Utils.normalizePath(path);
            var preprog = handler.writeProg || null;
            return this.collection
                .find({ _id: Utils.pathRegexp(path) }).sort({ _id: 1 })
                .toArray()
                .then(function (data) {
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
                    handler.sendValue(path, recomposer.get(), preprog, extra);
                    return;
                }
                _this.collection.findOne({ _id: Utils.parentPath(path) }).then(function (val) {
                    if (val == null) {
                        dbgBroker("Found no value on path %s using parent", path);
                        handler.sendValue(path, null, preprog, extra);
                    }
                    else {
                        var leaf = Utils.leafPath(path);
                        dbgBroker("Found %s on path %s using parent", val[leaf], path);
                        handler.sendValue(path, val[leaf], preprog, extra);
                    }
                });
            })
                .catch(function (e) {
                dbgBroker("Had error %s", e);
                // TODO handle this errors differently
            });
        };
        Broker.prototype.query = function (queryState) {
            var qo = {};
            var def = queryState.def;
            qo._id = queryState.pathRegex;
            if (def.compareField) {
                var leafField = Utils.leafPath(def.compareField);
                if (typeof (def.equals) !== 'undefined') {
                    qo[leafField] = def.equals;
                }
                else if (typeof (def.from) !== 'undefined' || typeof (def.to) !== 'undefined') {
                    qo[leafField] = {};
                    if (typeof (def.from) !== 'undefined')
                        qo[leafField].$gt = def.from;
                    if (typeof (def.to) !== 'undefined')
                        qo[leafField].$lt = def.to;
                }
            }
            dbgBroker("%s query object %o", queryState.id, qo);
            var cursor = this.collection.find(qo);
            var sortobj = {};
            if (def.compareField && typeof (def.equals) == 'undefined') {
                sortobj[def.compareField] = def.limitLast ? -1 : 1;
            }
            else {
                sortobj['_id'] = def.limitLast ? -1 : 1;
            }
            cursor = cursor.sort(sortobj);
            if (def.limit) {
                cursor = cursor.limit(def.limit);
            }
            //return cursor.toArray().then((data)=>console.log(data));
            cursor = cursor.stream();
            cursor.on('data', function (data) {
                var elementUrl = Utils.limitToChild(data._id, def.path);
                queryState.found(elementUrl, data);
            });
            cursor.on('end', function () {
                queryState.foundEnd();
                dbgBroker("%s cursor end", def.id);
            });
        };
        return Broker;
    }());
    exports.Broker = Broker;
    var ForwardingSubscriber = (function () {
        function ForwardingSubscriber(id, from, to) {
            this.id = id;
            this.from = from;
            this.to = to;
        }
        Object.defineProperty(ForwardingSubscriber.prototype, "closed", {
            get: function () {
                return this.from.closed || this.to.closed;
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(ForwardingSubscriber.prototype, "writeProg", {
            get: function () {
                return this.to.writeProg;
            },
            enumerable: true,
            configurable: true
        });
        ForwardingSubscriber.prototype.sendValue = function (path, val, prog, extra) {
            this.to.sendValue(path, val, prog, extra);
        };
        return ForwardingSubscriber;
    }());
    var SortAwareForwardingSubscriber = (function (_super) {
        __extends(SortAwareForwardingSubscriber, _super);
        function SortAwareForwardingSubscriber() {
            _super.apply(this, arguments);
            this.sorting = true;
            this.sent = {};
            this.cached = {};
            this.cachedUpd = {};
        }
        SortAwareForwardingSubscriber.prototype.sendValue = function (path, val, prog, extra) {
            if (!this.sorting) {
                _super.prototype.sendValue.call(this, path, val, prog, extra);
                return;
            }
            if (!extra.q) {
                // Not part of the query, it's probably an update
                var upcache = this.cachedUpd[path];
                if (!upcache) {
                    upcache = [];
                    this.cachedUpd[path] = upcache;
                }
                upcache.push({ p: path, v: val, n: prog, e: extra });
            }
            else if (extra.aft) {
                if (this.sent[extra.aft]) {
                    this.forward(path, val, prog, extra);
                }
                else {
                    dbgBroker("Caching %s cause %s not yet sent", path, extra.aft);
                    this.cached[extra.aft] = { p: path, v: val, n: prog, e: extra };
                }
            }
            else {
                this.forward(path, val, prog, extra);
            }
        };
        SortAwareForwardingSubscriber.prototype.forward = function (path, val, prog, extra) {
            this.sent[path] = true;
            _super.prototype.sendValue.call(this, path, val, prog, extra);
            var upcache = this.cachedUpd[path];
            if (upcache) {
                dbgBroker("Sending cached updates to %s", path);
                for (var i = 0; i < upcache.length; i++) {
                    var incache = upcache[i];
                    _super.prototype.sendValue.call(this, incache.p, incache.v, incache.n, incache.e);
                }
            }
            incache = this.cached[path];
            if (!incache)
                return;
            delete this.cached[path];
            dbgBroker("Sending %s cause %s now is sent", incache.p, path);
            this.forward(incache.p, incache.v, incache.n, incache.e);
        };
        SortAwareForwardingSubscriber.prototype.stopSorting = function () {
            dbgBroker("Stop sorting and flushing cache");
            // Flush anything still in cache
            var ks = Object.getOwnPropertyNames(this.cached);
            for (var i = 0; i < ks.length; i++) {
                var k = ks[i];
                var incache = this.cached[k];
                if (!incache)
                    continue;
                delete this.cached[k];
                this.forward(incache.p, incache.v, incache.n, incache.e);
            }
            // Clear cache and sent
            this.cached = null;
            this.cachedUpd = null;
            this.sent = null;
            this.sorting = false;
        };
        return SortAwareForwardingSubscriber;
    }(ForwardingSubscriber));
    var SimpleQueryState = (function () {
        function SimpleQueryState(handler, broker, def) {
            /**
             * path->sort value
             */
            this.invalues = [];
            this.closed = false;
            this.forwarder = null;
            this._pathRegex = null;
            this.fetchingCnt = 0;
            this.fetchEnded = false;
            this.handler = handler;
            this.broker = broker;
            this.def = def;
            this.forwarder = new SortAwareForwardingSubscriber(this.id + "fwd", this, this.handler);
        }
        Object.defineProperty(SimpleQueryState.prototype, "id", {
            get: function () {
                return this.def.id;
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(SimpleQueryState.prototype, "pathRegex", {
            get: function () {
                if (!this._pathRegex) {
                    var def = this.def;
                    // Limit to the path, and if needed subpath
                    var subp = null;
                    if (def.compareField) {
                        subp = Utils.parentPath(def.compareField);
                    }
                    subp = subp || '';
                    dbgBroker("Subpath %s", subp);
                    var path = def.path;
                    this._pathRegex = Utils.pathRegexp(path, subp);
                }
                return this._pathRegex;
            },
            enumerable: true,
            configurable: true
        });
        SimpleQueryState.prototype.positionFor = function (val) {
            if (this.def.limitLast) {
                for (var i = 0; i < this.invalues.length; i++) {
                    if (this.invalues[i].value < val)
                        return i;
                }
                return this.invalues.length;
            }
            else {
                for (var i = 0; i < this.invalues.length; i++) {
                    if (this.invalues[i].value > val)
                        return i;
                }
                return this.invalues.length;
            }
        };
        /**
         * Start the query, subscribing where needed
         */
        SimpleQueryState.prototype.start = function () {
            this.broker.query(this);
            this.broker.subscribe(this, this.def.path);
        };
        SimpleQueryState.prototype.stop = function () {
            this.closed = true;
            this.broker.unsubscribe(this, this.def.path);
            for (var k in this.invalues) {
                this.broker.unsubscribe(this, k);
                this.broker.unsubscribe(this.forwarder, k);
            }
        };
        SimpleQueryState.prototype.found = function (path, data) {
            var _this = this;
            var ind = this.invalues.length;
            var eleVal = null;
            if (this.def.compareField) {
                eleVal = data[Utils.leafPath(this.def.compareField)];
            }
            else {
                eleVal = Utils.leafPath(path);
            }
            ind = this.positionFor(eleVal);
            //dbgBroker("For element %s the sort value is %s and the position %s", path, eleVal, ind);
            var prePath = null;
            if (ind)
                prePath = this.invalues[ind - 1].path;
            this.invalues.splice(ind, 0, { path: path, value: eleVal });
            this.fetchingCnt++;
            this.broker.subscribe(this.forwarder, path);
            this.broker.fetch(this.forwarder, path, { q: this.id, aft: prePath }).then(function () {
                _this.fetchingCnt--;
                _this.checkEnd();
            });
        };
        SimpleQueryState.prototype.exited = function (path, ind) {
            this.handler.queryExit(path, this.id);
            this.broker.unsubscribe(this.forwarder, path);
            if (typeof (ind) == 'undefined') {
                for (var i = 0; i < this.invalues.length; i++) {
                    if (this.invalues[i].path == path) {
                        ind = i;
                        break;
                    }
                }
            }
            this.invalues.splice(ind, 1);
        };
        SimpleQueryState.prototype.foundEnd = function () {
            this.fetchEnded = true;
            this.checkEnd();
        };
        SimpleQueryState.prototype.checkEnd = function () {
            if (this.fetchingCnt == 0 && this.fetchEnded) {
                this.forwarder.stopSorting();
                this.handler.queryFetchEnd(this.id);
            }
        };
        SimpleQueryState.prototype.checkExit = function (path) {
            for (var i = 0; i < this.invalues.length; i++) {
                if (this.invalues[i].path == path) {
                    this.exited(path, i);
                    return;
                }
            }
        };
        SimpleQueryState.prototype.sendValue = function (path, val, prog, extra) {
            var extra = {};
            _a = Utils.normalizeUpdatedValue(path, val), path = _a[0], val = _a[1];
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
                }
                else {
                    eleVal = Utils.leafPath(path);
                }
                // Check if the value is in the acceptable range
                if (typeof (this.def.equals) !== 'undefined') {
                    if (this.def.equals != eleVal)
                        return this.checkExit(path);
                }
                else if (typeof (this.def.from) !== 'undefined') {
                    if (eleVal < this.def.from)
                        return this.checkExit(path);
                }
                else if (typeof (this.def.to) !== 'undefined') {
                    if (eleVal > this.def.to)
                        return this.checkExit(path);
                }
                var pos = this.positionFor(eleVal);
                if (this.def.limit) {
                    // If the position is over the limit we can discard this
                    if (pos >= this.def.limit)
                        return this.checkExit(path);
                }
                // We have a new value to insert
                this.invalues.splice(pos, 0, { path: path, value: eleVal });
                var prePath = null;
                if (pos)
                    prePath = this.invalues[pos - 1].path;
                this.broker.fetch(this.forwarder, path, { q: this.id, aft: prePath });
                if (this.def.limit) {
                    // Check who went out
                    var ele = this.invalues[this.invalues.length - 1];
                    this.exited(ele.path, this.invalues.length);
                }
            }
            var _a;
        };
        return SimpleQueryState;
    }());
    exports.SimpleQueryState = SimpleQueryState;
    function filterAck(fn, val) {
        if (!fn || typeof fn !== 'function')
            return;
        fn(val);
    }
    // Does not need to export, but there are no friendly/package/module accessible methods, and Broker.subscribe will complain is Handler is private
    var Handler = (function () {
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
        function Handler(socket, authData, broker) {
            var _this = this;
            this.socket = socket;
            this.authData = authData;
            this.broker = broker;
            this.id = 'na';
            this.closed = false;
            this.pathSubs = {};
            this.queries = {};
            this.ongoingReads = {};
            this.ongoingWrite = null;
            this.writeQueue = [];
            this.readQueue = [];
            this.writeProg = 1;
            this.id = socket.id.substr(2);
            dbgHandler("%s handler created", this.id);
            socket.on('sp', function (path, fn) { return _this.enqueueRead(function () { return filterAck(fn, _this.subscribePath(path)); }); });
            socket.on('up', function (path, fn) { return filterAck(fn, _this.unsubscribePath(path)); });
            socket.on('pi', function (writeProg, fn) { return filterAck(fn, _this.ping(writeProg)); });
            socket.on('sq', function (def, fn) { return _this.enqueueRead(function () { return filterAck(fn, _this.subscribeQuery(def)); }); });
            socket.on('uq', function (id, fn) { return filterAck(fn, _this.unsubscribeQuery(id)); });
            socket.on('s', function (path, val, prog, fn) { return _this.enqueueWrite(function () { return _this.set(path, val, prog, fn); }); });
            socket.on('m', function (path, val, prog, fn) { return _this.enqueueWrite(function () { return _this.merge(path, val, prog, fn); }); });
            socket.on('disconnect', function () {
                _this.close();
            });
            broker.register(this);
            socket.emit('aa');
            socket.on('aa', function () { socket.emit('aa'); });
        }
        Handler.prototype.enqueueRead = function (fn) {
            // If no write operation in the queue (waiting or executing) fire the read
            if (this.writeQueue.length == 0 && !this.ongoingWrite)
                return fn();
            // Otherwise queue the read
            this.readQueue.push(fn);
            dbgHandler("%s enqueued read operation, now %s in queue", this.id, this.readQueue.length);
        };
        Handler.prototype.enqueueWrite = function (fn) {
            // Anyway put the write in the queue
            this.writeQueue.push(fn);
            dbgHandler("%s enqueued write operation, now %s in queue", this.id, this.writeQueue.length);
            this.dequeue();
        };
        Handler.prototype.dequeue = function () {
            // If there is something in the write queue, fire it
            if (this.writeQueue.length) {
                // If there are no reads going on
                for (var k in this.ongoingReads)
                    return;
                // If there is no write already going on 
                if (this.ongoingWrite)
                    return;
                // Fire the write
                dbgHandler("%s dequeuing write operation", this.id);
                this.ongoingWrite = this.writeQueue.shift();
                this.ongoingWrite();
                return;
            }
            // Otherwise fire all reads
            var readfn = null;
            while ((readfn = this.readQueue.pop())) {
                dbgHandler("%s dequeuing read operation", this.id);
                readfn();
            }
        };
        Handler.prototype.updateAuthData = function (data) {
            this.authData = data;
        };
        Handler.prototype.close = function () {
            dbgHandler("%s closing handler", this.id);
            if (this.closed)
                return;
            this.closed = true;
            this.socket.removeAllListeners();
            this.readQueue = null;
            this.writeQueue = null;
            this.socket = null;
            for (var k in this.pathSubs) {
                this.broker.unsubscribe(this, k);
            }
            for (var k in this.queries) {
                this.queries[k].stop();
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
            this.ongoingReads[path] = true;
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
            delete this.ongoingReads[path];
            this.broker.unsubscribe(this, path);
            return 'k';
        };
        Handler.prototype.subscribeQuery = function (def) {
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
        };
        Handler.prototype.unsubscribeQuery = function (id) {
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
        };
        Handler.prototype.ping = function (writeProg) {
            dbgHandler("%s received ping %s", this.id, writeProg);
            this.writeProg = writeProg;
            return writeProg;
        };
        Handler.prototype.set = function (path, val, prog, cb) {
            var _this = this;
            dbgHandler("%s writing prog %s in %s %o", this.id, prog, path, val);
            this.writeProg = Math.max(this.writeProg, prog);
            // TODO security here
            this.broker.set(this, path, val)
                .then(function () {
                _this.ongoingWrite = null;
                _this.dequeue();
                filterAck(cb, 'k');
            })
                .catch(function (e) {
                _this.ongoingWrite = null;
                _this.dequeue();
                dbgHandler("Got error", e);
                filterAck(cb, e.message);
            });
        };
        Handler.prototype.merge = function (path, val, prog, cb) {
            var _this = this;
            dbgHandler("%s merging prog %s in %s %o", this.id, prog, path, val);
            this.writeProg = Math.max(this.writeProg, prog);
            // TODO security here
            this.broker.merge(this, path, val)
                .then(function () {
                _this.ongoingWrite = null;
                _this.dequeue();
                filterAck(cb, 'k');
            })
                .catch(function (e) {
                _this.ongoingWrite = null;
                _this.dequeue();
                dbgHandler("Got error", e);
                filterAck(cb, e.message);
            });
        };
        Handler.prototype.sendValue = function (path, val, prog, extra) {
            if (this.closed)
                return;
            // TODO evaluate query matching
            // TODO security filter here?
            var msg = { p: path, v: val, n: prog };
            for (var k in extra) {
                msg[k] = extra[k];
            }
            dbgHandler("%s sending value %o", this.id, msg);
            this.socket.emit('v', msg);
            if (!extra || !extra.q) {
                delete this.ongoingReads[path];
                this.dequeue();
            }
        };
        Handler.prototype.queryFetchEnd = function (queryId) {
            if (this.closed)
                return;
            dbgHandler("%s sending query end %s", this.id, queryId);
            this.socket.emit('qd', { q: queryId });
            delete this.ongoingReads['$q' + queryId];
            this.dequeue();
        };
        Handler.prototype.queryExit = function (path, queryId) {
            if (this.closed)
                return;
            dbgHandler("%s sending query exit %s:%s", this.id, queryId, path);
            this.socket.emit('qx', { q: queryId, p: path, n: this.writeProg });
        };
        return Handler;
    }());
    exports.Handler = Handler;
    var Recomposer = (function () {
        function Recomposer(base) {
            this.refs = {};
            this.base = Utils.normalizePath(base);
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
            var par = Utils.parentPath(path);
            var lst = Utils.leafPath(path);
            var preobj = {};
            preobj[lst] = acref;
            this.findOrCreateRefFor(par, preobj);
        };
        return Recomposer;
    }());
    exports.Recomposer = Recomposer;
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    var socketcnt = 1;
    var LocalSocket = (function () {
        function LocalSocket() {
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
        return LocalSocket;
    }());
    exports.LocalSocket = LocalSocket;
    var InternalSocket = (function (_super) {
        __extends(InternalSocket, _super);
        function InternalSocket() {
            _super.call(this);
        }
        InternalSocket.prototype.emit = function (name) {
            var args = [];
            for (var _i = 1; _i < arguments.length; _i++) {
                args[_i - 1] = arguments[_i];
            }
            var lstnrs = this.other.listeners(name);
            var val;
            // Add a do-nothing callback, in case the listener expects it but the emitter didn't provide a real one
            args.push(function () { });
            for (var i = 0; i < lstnrs.length; i++) {
                try {
                    val = lstnrs[i].apply(this, args);
                }
                catch (e) {
                    dbgSocket('Internal socket emit %s error %o', name, e);
                }
            }
            return !!lstnrs.length;
        };
        return InternalSocket;
    }(events_1.EventEmitter));
});

//# sourceMappingURL=Broker.js.map
