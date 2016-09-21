"use strict";
var Mongo = require('mongodb');
var Debug = require('debug');
Debug.enable('tsdb:*');
var SocketIO = require('socket.io');
var SocketClient = require('socket.io-client');
var Broker_1 = require('../main/Broker');
var Utils = require('../main/Utils');
var tsmatchers_1 = require('tsmatchers');
var tsMatchers_1 = require('tsmatchers/js/main/tsMatchers');
var mongoUrl = 'mongodb://localhost:27017/';
var socketURL = 'http://0.0.0.0:5000';
var socketServer;
var localSocket;
var useLocalSocket = true;
var lastBroker;
function getBroker() {
    var proms = [];
    if (lastBroker)
        proms.push(lastBroker.close());
    if (socketServer)
        socketServer.close();
    if (!useLocalSocket) {
        socketServer = SocketIO.listen(5000);
    }
    else {
        socketServer = null;
    }
    var brk = new Broker_1.Broker(socketServer, mongoUrl + 'test', 'bag1', mongoUrl + 'local');
    lastBroker = brk;
    proms.push(brk.start());
    return Promise.all(proms).then(function () {
        var ret = brk;
        return ret;
    });
}
var lastConn;
function getConnection() {
    if (lastConn)
        lastConn.close();
    if (useLocalSocket) {
        localSocket = new Broker_1.LocalSocket();
        lastBroker.handle(localSocket.server, null);
        return localSocket.client;
    }
    else {
        var socketOptions = {
            transports: ['websocket'],
            'force new connection': true
        };
        return lastConn = SocketClient.connect(socketURL, socketOptions);
    }
}
function getConnectedClient() {
    return getBroker().then(function (brk) {
        var conn = getConnection();
        return new Promise(function (res, rej) {
            var done = false;
            conn.on('aa', function () {
                if (done)
                    return;
                done = true;
                var hnd = brk.handlers[conn.id];
                res({ broker: brk, connection: conn, handler: hnd });
            });
            conn.emit('aa');
        });
    });
}
var mongoDb;
var mongoColl;
Mongo.MongoClient.connect(mongoUrl + 'test').then(function (db) {
    mongoDb = db;
    mongoColl = db.collection('bag1');
});
function sendCommand(cc, cmd) {
    var args = [];
    for (var _i = 2; _i < arguments.length; _i++) {
        args[_i - 2] = arguments[_i];
    }
    return new Promise(function (res, rej) {
        var params = [cmd];
        params = params.concat(args);
        params.push(function (ack) {
            res(ack);
        });
        cc.connection.emit.apply(cc.connection, params);
    });
}
function checkEvents(conn, events, anyOrder) {
    if (anyOrder === void 0) { anyOrder = false; }
    var ret = [];
    var cbs = {};
    var cp = new Promise(function (res, err) {
        var evtIds = {};
        for (var i = 0; i < events.length; i++) {
            evtIds[events[i].event] = true;
        }
        var acevt = 0;
        var _loop_1 = function(k) {
            cb = function (obj) {
                try {
                    ret.push({ event: k, match: obj });
                    tsmatchers_1.assert("Got too many events", events, tsmatchers_1.is.not.array.withLength(0));
                    if (anyOrder) {
                        var found = false;
                        var match = null;
                        for (var i = 0; i < events.length; i++) {
                            var acevobj = events[i];
                            if (acevobj.event != k)
                                continue;
                            match = tsMatchers_1.matcherOrEquals(acevobj.match);
                            if (match.matches(obj)) {
                                events.splice(i, 1);
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            tsmatchers_1.assert("There is a matching event", obj, match);
                        }
                    }
                    else {
                        var acevobj = events.shift();
                        tsmatchers_1.assert("Checking event " + (acevt++) + " of type " + acevobj.event, obj, acevobj.match);
                    }
                    if (events.length == 0)
                        res(ret);
                }
                catch (e) {
                    console.log("Received events", ret);
                    err(e);
                }
            };
            conn.on(k, cb);
            cbs[k] = cb;
        };
        var cb;
        for (var k in evtIds) {
            _loop_1(k);
        }
    });
    cp.stop = function () {
        for (var k in cbs) {
            conn.removeListener(k, cbs[k]);
        }
    };
    return cp;
}
describe("Broker >", function () {
    describe("Basics >", function () {
        it('Should normalize paths', function () {
            var paths = [
                'ciao/mamma',
                '/ciao/mamma/',
                '/ciao/../mamma/',
                '//ciao///mamma/./'
            ];
            for (var i = 0; i < paths.length; i++) {
                tsmatchers_1.assert("Checking path '" + paths[i] + "'", Utils.normalizePath(paths[i]), '/ciao/mamma');
            }
        });
        it('Should limitToChild paths', function () {
            tsmatchers_1.assert('wrong subpath', Utils.limitToChild('/users/1/sub/name', '/people'), tsmatchers_1.is.falsey);
            tsmatchers_1.assert('single element', Utils.limitToChild('/users/1', '/users'), '/users/1');
            tsmatchers_1.assert('one sub element', Utils.limitToChild('/users/1/sub', '/users'), '/users/1');
            tsmatchers_1.assert('two sub element', Utils.limitToChild('/users/1/sub/name', '/users'), '/users/1');
        });
        it('Should create a broker', function () {
            return getBroker().then(function (brk) { return brk.close(); });
        });
        it('Should handle a connection', function (done) {
            getBroker().then(function (brk) {
                ;
                var conn = getConnection();
                tsmatchers_1.assert("Returned a connection", conn, tsmatchers_1.is.defined);
                conn.on('aa', function () {
                    tsmatchers_1.assert("Handler is in place", brk.handlers, tsmatchers_1.is.object.withKeys(conn.id));
                    var handler = brk.handlers[conn.id];
                    tsmatchers_1.assert("Handler has right id", handler.id, conn.id);
                    conn.emit('pi', 123, function (resp) {
                        tsmatchers_1.assert("responded to the ping", resp, 123);
                        done();
                    });
                });
                conn.emit('aa');
            });
        });
        describe('Local socket >', function () {
            it('Should send and receive', function () {
                var sock = new Broker_1.LocalSocket();
                tsmatchers_1.assert("Has same id", sock.server.id.substr(2), sock.client.id);
                var clrecv = [];
                var srrecv = [];
                sock.client.on('test1', function (val) { return clrecv.push('test1:' + val); });
                sock.client.on('test2', function (val) { return clrecv.push('test2:' + val); });
                sock.server.on('test1', function (val) { return srrecv.push('test1:' + val); });
                sock.server.on('test2', function (val) { return srrecv.push('test2:' + val); });
                sock.client.emit('test1', 'ciao');
                sock.server.emit('test1', 'come va');
                sock.client.emit('test2', 'ok');
                tsmatchers_1.assert("Server received messages", srrecv, tsmatchers_1.is.array.equals(['test1:ciao', 'test2:ok']));
                tsmatchers_1.assert("Client received messages", clrecv, tsmatchers_1.is.array.equals(['test1:come va']));
            });
            it('Should obey callbacks', function () {
                var sock = new Broker_1.LocalSocket();
                sock.client.on('test1', function (val, cb) {
                    tsmatchers_1.assert("There is a callback", cb, tsmatchers_1.is.function);
                    cb('kk');
                });
                var got = null;
                sock.server.emit('test1', 'ciao', function (resp) {
                    got = resp;
                });
                tsmatchers_1.assert("got reponse", got, 'kk');
            });
        });
    });
    describe("Writing >", function () {
        describe("Set >", function () {
            it('Should correctly unroll simple objects', function () {
                var brk = new Broker_1.Broker();
                var unroll = [];
                brk.recursiveUnroll('/test/root', { a: 1, b: { c: { d: 1 } } }, unroll);
                tsmatchers_1.assert("right length of unroll", unroll, tsmatchers_1.is.array.withLength(2));
                tsmatchers_1.assert("has element for a:1", unroll, tsmatchers_1.is.array.containing(tsmatchers_1.is.object.matching({ _id: '/test/root', a: 1 })));
                tsmatchers_1.assert("has element for d:1", unroll, tsmatchers_1.is.array.containing(tsmatchers_1.is.object.matching({ _id: '/test/root/b/c', d: 1 })));
            });
            it('Should write a primitive string', function () {
                return mongoColl.deleteMany({}).then(function () {
                    return getConnectedClient();
                }).then(function (cc) {
                    return sendCommand(cc, 's', '/test/data', 'ciao', 2);
                }).then(function (ack) {
                    tsmatchers_1.assert("returned correct ack", ack, 'k');
                    return mongoColl.find({}).toArray();
                }).then(function (data) {
                    tsmatchers_1.assert("should exist only one data", data, tsmatchers_1.is.array.withLength(1));
                    var rec = data[0];
                    tsmatchers_1.assert("record is right", rec, tsmatchers_1.is.object.matching({ _id: '/test', data: 'ciao' }));
                });
            });
            it('Should write a primitive number', function () {
                return mongoColl.deleteMany({}).then(function () {
                    return getConnectedClient();
                }).then(function (cc) {
                    return sendCommand(cc, 's', '/test/data', 100, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert("returned correct ack", ack, 'k');
                    return mongoColl.find({}).toArray();
                }).then(function (data) {
                    tsmatchers_1.assert("should exist only one data", data, tsmatchers_1.is.array.withLength(1));
                    var rec = data[0];
                    tsmatchers_1.assert("record is right", rec, tsmatchers_1.is.object.matching({ _id: '/test', data: 100 }));
                });
            });
            it('Should write a simple object', function () {
                return mongoColl.deleteMany({}).then(function () {
                    return getConnectedClient();
                }).then(function (cc) {
                    return sendCommand(cc, 's', '/testData', { a: 1 }, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert("returned correct ack", ack, 'k');
                    return mongoColl.find({}).toArray();
                }).then(function (data) {
                    tsmatchers_1.assert("should exist only one data", data, tsmatchers_1.is.array.withLength(1));
                    var rec = data[0];
                    tsmatchers_1.assert("record is right", rec, tsmatchers_1.is.object.matching({ _id: '/testData', a: 1 }));
                });
            });
            it('Should write a primitive in first level child', function () {
                return mongoColl.deleteMany({}).then(function () {
                    return getConnectedClient();
                }).then(function (cc) {
                    return sendCommand(cc, 's', '/test', 'ciao', 2);
                }).then(function (ack) {
                    tsmatchers_1.assert("returned correct ack", ack, 'k');
                    return mongoColl.find({}).toArray();
                }).then(function (data) {
                    tsmatchers_1.assert("should exist only one data", data, tsmatchers_1.is.array.withLength(1));
                    var rec = data[0];
                    tsmatchers_1.assert("record is right", rec, tsmatchers_1.is.object.matching({ _id: '', test: 'ciao' }));
                });
            });
            it('Should write a complex object', function () {
                return mongoColl.deleteMany({}).then(function () {
                    return getConnectedClient();
                }).then(function (cc) {
                    return sendCommand(cc, 's', '/user/1', { name: 'simone', surname: 'gianni', addresses: [{ label: 'home', line: 'via tiburtina' }, { label: 'office', line: 'viale carso' }] }, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert("returned correct ack", ack, 'k');
                    return mongoColl.find({}).toArray();
                }).then(function (data) {
                    tsmatchers_1.assert("should exist all the data", data, tsmatchers_1.is.array.withLength(3));
                    tsmatchers_1.assert("record for user is right", data, tsmatchers_1.is.array.containing(tsmatchers_1.is.strictly.object.matching({ _id: '/user/1', name: 'simone', surname: 'gianni' })));
                    tsmatchers_1.assert("record for home address", data, tsmatchers_1.is.array.containing(tsmatchers_1.is.strictly.object.matching({ _id: '/user/1/addresses/0', label: 'home', line: 'via tiburtina' })));
                    tsmatchers_1.assert("record for office address", data, tsmatchers_1.is.array.containing(tsmatchers_1.is.strictly.object.matching({ _id: '/user/1/addresses/1', label: 'office', line: 'viale carso' })));
                });
            });
            it('Should preserve other leafs', function () {
                var cc;
                return mongoColl.deleteMany({}).then(function () {
                    return getConnectedClient();
                }).then(function (ncc) {
                    cc = ncc;
                    return sendCommand(cc, 's', '/test', { data1: 'ciao', data2: 'come', data3: 'va' }, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert("returned correct ack", ack, 'k');
                    return mongoColl.find({}).toArray();
                }).then(function (data) {
                    tsmatchers_1.assert("should exist only one data", data, tsmatchers_1.is.array.withLength(1));
                    var rec = data[0];
                    tsmatchers_1.assert("record is right", rec, tsmatchers_1.is.strictly.object.matching({ _id: '/test', data1: 'ciao', data2: 'come', data3: 'va' }));
                    return sendCommand(cc, 's', '/test/data2', 'quanto', 3);
                }).then(function (ack) {
                    tsmatchers_1.assert("returned correct ack", ack, 'k');
                    return mongoColl.find({}).toArray();
                }).then(function (data) {
                    tsmatchers_1.assert("should exist only one data", data, tsmatchers_1.is.array.withLength(1));
                    var rec = data[0];
                    tsmatchers_1.assert("record is right", rec, tsmatchers_1.is.strictly.object.matching({ _id: '/test', data1: 'ciao', data2: 'quanto', data3: 'va' }));
                });
            });
        });
        describe('Merge >', function () {
            beforeEach(function () {
                return getConnectedClient().then(function (cc) {
                    return mongoColl.deleteMany({}).then(function () { return cc; });
                }).then(function (cc) {
                    return sendCommand(cc, 's', '/users', [
                        {
                            name: 'simone', surname: 'gianni',
                            addresses: [
                                { name: 'home', line: 'via tiburtina' },
                                { name: 'office', line: 'viale carso' }
                            ]
                        },
                        {
                            name: 'sara', surname: 'gianni',
                            addresses: [
                                { name: 'home', line: 'via tiburtina' },
                                { name: 'office', line: 'via luca signorelli' }
                            ]
                        }
                    ], 1);
                });
            });
            it('Should correctly unroll deletes for simple objects', function () {
                var brk = new Broker_1.Broker();
                var unroll = [];
                var deletes = [];
                brk.recursiveUnroll('/test/root', { a: 1, b: { c: { d: 1 } }, e: null, f: { g: null } }, unroll, deletes);
                tsmatchers_1.assert("right length of unroll", unroll, tsmatchers_1.is.array.withLength(2));
                tsmatchers_1.assert("has element for a:1", unroll, tsmatchers_1.is.array.containing(tsmatchers_1.is.object.matching({ _id: '/test/root', a: 1 })));
                tsmatchers_1.assert("has element for d:1", unroll, tsmatchers_1.is.array.containing(tsmatchers_1.is.object.matching({ _id: '/test/root/b/c', d: 1 })));
                tsmatchers_1.assert("right length of deletes", deletes, tsmatchers_1.is.array.withLength(2));
                tsmatchers_1.assert("has deletes for e:null", deletes, tsmatchers_1.is.array.containing('/test/root/e'));
                tsmatchers_1.assert("has deletes for e:null", deletes, tsmatchers_1.is.array.containing('/test/root/f/g'));
            });
            it('Should update simple object values', function () {
                return getConnectedClient().then(function (cc) {
                    return sendCommand(cc, 'm', '/users/0', { phone: 'iphone', addresses: null, surname: null }, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert("returned correct ack", ack, 'k');
                    return mongoColl.find({}).toArray();
                }).then(function (data) {
                    tsmatchers_1.assert("should exist the right datas", data, tsmatchers_1.is.array.withLength(4));
                    tsmatchers_1.assert("record merged user is right", data, tsmatchers_1.is.array.containing(tsmatchers_1.is.strictly.object.matching({ _id: '/users/0', phone: 'iphone', name: 'simone' })));
                    tsmatchers_1.assert("record for user is right", data, tsmatchers_1.is.array.containing(tsmatchers_1.is.strictly.object.matching({ _id: '/users/1', name: 'sara', surname: 'gianni' })));
                    tsmatchers_1.assert("record for home address", data, tsmatchers_1.is.array.containing(tsmatchers_1.is.strictly.object.matching({ _id: '/users/1/addresses/0', name: 'home', line: 'via tiburtina' })));
                    tsmatchers_1.assert("record for office address", data, tsmatchers_1.is.array.containing(tsmatchers_1.is.strictly.object.matching({ _id: '/users/1/addresses/1', name: 'office', line: 'via luca signorelli' })));
                });
            });
        });
    });
    describe('Deleting >', function () {
        it('Should delete the entire path given to set', function () {
            var cc = null;
            return mongoColl.deleteMany({}).then(function () {
                return getConnectedClient();
            }).then(function (ncc) {
                cc = ncc;
                return sendCommand(cc, 's', '/user/1', { name: 'simone', surname: 'gianni', addresses: [{ label: 'home', line: 'via tiburtina' }, { label: 'office', line: 'viale carso' }] }, 2);
            }).then(function (ack) {
                tsmatchers_1.assert("returned correct ack", ack, 'k');
                return mongoColl.find({}).toArray();
            }).then(function (data) {
                tsmatchers_1.assert("should exist all the data", data, tsmatchers_1.is.array.withLength(3));
                return sendCommand(cc, 's', '/user/1', null, 3);
            }).then(function (ack) {
                tsmatchers_1.assert("returned correct ack", ack, 'k');
                return mongoColl.find({}).toArray();
            }).then(function (data) {
                tsmatchers_1.assert("should have deleted some data", data, tsmatchers_1.is.array.withLength(0));
            });
        });
        it('Should delete a sub path given to set', function () {
            var cc = null;
            return mongoColl.deleteMany({}).then(function () {
                return getConnectedClient();
            }).then(function (ncc) {
                cc = ncc;
                return sendCommand(cc, 's', '/user/1', { name: 'simone', surname: 'gianni', addresses: [{ label: 'home', line: 'via tiburtina' }, { label: 'office', line: 'viale carso' }] }, 2);
            }).then(function (ack) {
                tsmatchers_1.assert("returned correct ack", ack, 'k');
                return mongoColl.find({}).toArray();
            }).then(function (data) {
                tsmatchers_1.assert("should exist all the data", data, tsmatchers_1.is.array.withLength(3));
                return sendCommand(cc, 's', '/user/1/addresses/1', null, 3);
            }).then(function (ack) {
                tsmatchers_1.assert("returned correct ack", ack, 'k');
                return mongoColl.find({}).toArray();
            }).then(function (data) {
                tsmatchers_1.assert("should have deleted some data", data, tsmatchers_1.is.array.withLength(2));
            });
        });
        it('Should delete a leaf', function () {
            var cc = null;
            return mongoColl.deleteMany({}).then(function () {
                return getConnectedClient();
            }).then(function (ncc) {
                cc = ncc;
                return sendCommand(cc, 's', '/user/1', { name: 'simone', surname: 'gianni' }, 2);
            }).then(function (ack) {
                tsmatchers_1.assert("returned correct ack", ack, 'k');
                return mongoColl.find({}).toArray();
            }).then(function (data) {
                tsmatchers_1.assert("should exist all the data", data, tsmatchers_1.is.array.withLength(1));
                var rec = data[0];
                tsmatchers_1.assert("object should match", rec, tsmatchers_1.is.strictly.object.matching({ _id: tsmatchers_1.is.string, name: 'simone', surname: 'gianni' }));
                return sendCommand(cc, 's', '/user/1/name', null, 3);
            }).then(function (ack) {
                tsmatchers_1.assert("returned correct ack", ack, 'k');
                return mongoColl.find({}).toArray();
            }).then(function (data) {
                tsmatchers_1.assert("should exist all the data", data, tsmatchers_1.is.array.withLength(1));
                var rec = data[0];
                tsmatchers_1.assert("object should match", rec, tsmatchers_1.is.strictly.object.matching({ _id: tsmatchers_1.is.string, surname: 'gianni' }));
            });
        });
        it('Should delete a sub path given as an empty object', function () {
            var cc = null;
            return mongoColl.deleteMany({}).then(function () {
                return getConnectedClient();
            }).then(function (ncc) {
                cc = ncc;
                return sendCommand(cc, 's', '/user/1', { name: 'simone', surname: 'gianni', addresses: [{ label: 'home', line: 'via tiburtina' }, { label: 'office', line: 'viale carso' }] }, 2);
            }).then(function (ack) {
                tsmatchers_1.assert("returned correct ack", ack, 'k');
                return mongoColl.find({}).toArray();
            }).then(function (data) {
                tsmatchers_1.assert("should exist all the data", data, tsmatchers_1.is.array.withLength(3));
                return sendCommand(cc, 's', '/user/1/addresses', {}, 3);
            }).then(function (ack) {
                tsmatchers_1.assert("returned correct ack", ack, 'k');
                return mongoColl.find({}).toArray();
            }).then(function (data) {
                tsmatchers_1.assert("should have deleted some data", data, tsmatchers_1.is.array.withLength(1));
            });
        });
    });
    describe("Reading >", function () {
        beforeEach(function () {
            return getConnectedClient().then(function (cc) {
                return mongoColl.deleteMany({}).then(function () { return cc; });
            }).then(function (cc) {
                return sendCommand(cc, 's', '/users', [
                    {
                        name: 'simone', surname: 'gianni',
                        addresses: [
                            { name: 'home', line: 'via tiburtina' },
                            { name: 'office', line: 'viale carso' }
                        ]
                    },
                    {
                        name: 'sara', surname: 'gianni',
                        addresses: [
                            { name: 'home', line: 'via tiburtina' },
                            { name: 'office', line: 'via luca signorelli' }
                        ]
                    },
                    { name: 'simone', surname: 'altro' },
                    { name: 'simone', surname: 'ultro' },
                ], 1);
            });
        });
        it('Should correctly recompose objects', function () {
            var rec = new Broker_1.Recomposer('/users/1');
            rec.add({ _id: '/users/1', name: 'simone', surname: 'gianni' });
            tsmatchers_1.assert('basic composition is right', rec.get(), tsmatchers_1.is.object.matching({ name: 'simone', surname: 'gianni' }));
            rec.add({ _id: '/users/1/phone', model: 'iphone', year: 2016 });
            tsmatchers_1.assert('sub composition is right', rec.get(), tsmatchers_1.is.object.matching({ phone: { model: 'iphone', year: 2016 } }));
            rec.add({ _id: '/users/1/addresses/0', name: "home", line: "via tiburtina" });
            tsmatchers_1.assert('nested composition is right', rec.get(), tsmatchers_1.is.object.matching({ addresses: { 0: { name: "home", line: "via tiburtina" } } }));
            rec = new Broker_1.Recomposer('/users/1');
            rec.add({ _id: '/users/1/addresses/0', name: "home", line: "via tiburtina" });
            rec.add({ _id: '/users/1/addresses/1', name: "office", line: "viale carso" });
            rec.add({ _id: '/users/1', name: 'simone', surname: 'gianni' });
            tsmatchers_1.assert('reverse composition is right', rec.get(), tsmatchers_1.is.object.matching({
                name: 'simone', surname: 'gianni',
                addresses: [
                    { name: 'home', line: 'via tiburtina' },
                    { name: 'office', line: 'viale carso' }
                ]
            }));
        });
        describe('Fetching >', function () {
            it('Should fetch a simple object', function (done) {
                return getConnectedClient().then(function (cc) {
                    cc.connection.on('v', function (pl) {
                        tsmatchers_1.assert("right payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2', v: { name: 'simone', surname: 'altro' }, n: 1 }));
                        done();
                    });
                    return sendCommand(cc, 'sp', '/users/2');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                });
            });
            it('Should fetch a complex object', function (done) {
                return getConnectedClient().then(function (cc) {
                    cc.connection.on('v', function (pl) {
                        tsmatchers_1.assert("right payload", pl, tsmatchers_1.is.object.matching({
                            p: '/users/0',
                            v: {
                                name: 'simone', surname: 'gianni',
                                addresses: [
                                    { name: 'home', line: 'via tiburtina' },
                                    { name: 'office', line: 'viale carso' }
                                ]
                            },
                            n: 1
                        }));
                        done();
                    });
                    return sendCommand(cc, 'sp', '/users/0');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                });
            });
            it('should fetch a specific value', function (done) {
                return getConnectedClient().then(function (cc) {
                    cc.connection.on('v', function (pl) {
                        tsmatchers_1.assert("right payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2/name', v: 'simone', n: 1 }));
                        done();
                    });
                    return sendCommand(cc, 'sp', '/users/2/name');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                });
            });
            it('should fetch root', function () {
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.eventCheck = checkEvents(cc.connection, [
                        {
                            event: 'v',
                            match: tsmatchers_1.is.object.matching({
                                v: {
                                    users: tsmatchers_1.is.defined
                                },
                                n: 1
                            })
                        }
                    ]);
                    return sendCommand(cc, 'sp', '/');
                }).then(function (ack) {
                    tsmatchers_1.assert("Got ack from the sub", ack, 'k');
                    return cc.eventCheck;
                }).then(function (evts) {
                    console.log(evts);
                });
            });
        });
        describe("Path notify >", function () {
            it('Should notify of changes on a simple object', function (done) {
                var evtCount = 0;
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.connection.on('v', function (pl) {
                        if (evtCount == 0) {
                            tsmatchers_1.assert("right fetch payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2', v: { name: 'simone', surname: 'altro' }, n: 1 }));
                        }
                        else if (evtCount == 1) {
                            tsmatchers_1.assert("right update payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2', v: { name: 'simona', surname: 'altrini' }, n: 2 }));
                            done();
                        }
                        evtCount++;
                    });
                    return sendCommand(cc, 'sp', '/users/2');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return sendCommand(cc, 's', '/users/2', { name: 'simona', surname: 'altrini' }, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                });
            });
            it('Should notify of changes done with merge', function () {
                var evts = [];
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.connection.on('v', function (pl) {
                        evts.push(pl);
                    });
                    return sendCommand(cc, 'sp', '/users/2');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return sendCommand(cc, 'm', '/users/2', { name: 'simona', surname: null, phone: 'iphone' }, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return wait(100);
                }).then(function () {
                    tsmatchers_1.assert("right number of events", evts, tsmatchers_1.is.array.withLength(4));
                    tsmatchers_1.assert("has event for name:simona", evts, tsmatchers_1.is.array.containing(tsmatchers_1.is.object.matching({ "p": "/users/2", "v": { "name": "simone", "surname": "altro" }, n: 1 })));
                    tsmatchers_1.assert("has event for name:simona", evts, tsmatchers_1.is.array.containing(tsmatchers_1.is.object.matching({ p: '/users/2/name', v: 'simona', n: 2 })));
                    tsmatchers_1.assert("has event for surname:null", evts, tsmatchers_1.is.array.containing(tsmatchers_1.is.object.matching({ p: '/users/2/surname', v: null, n: 2 })));
                    tsmatchers_1.assert("has event for phone:iphone", evts, tsmatchers_1.is.array.containing(tsmatchers_1.is.object.matching({ p: '/users/2/phone', v: 'iphone', n: 2 })));
                });
            });
            it('Should notify of changes on specific value', function () {
                var evtCount = 0;
                var cc = null;
                var pkprom = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.connection.on('v', function (pl) {
                        console.log('in on(v) ' + evtCount);
                        pkprom.resolve();
                        if (evtCount == 0) {
                            tsmatchers_1.assert("right fetch payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2/name', v: 'simone', n: 1 }));
                        }
                        else if (evtCount == 1) {
                            tsmatchers_1.assert("right update payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2/name', v: 'sara', n: 2 }));
                        }
                        evtCount++;
                    });
                    pkprom = extPromise();
                    return sendCommand(cc, 'sp', '/users/2/name');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return pkprom;
                }).then(function () {
                    pkprom = extPromise();
                    return sendCommand(cc, 's', '/users/2/name', 'sara', 2);
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return pkprom;
                });
            });
            it('Should notify changes up', function (done) {
                var evtCount = 0;
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.connection.on('v', function (pl) {
                        if (evtCount == 0) {
                            tsmatchers_1.assert("right fetch payload", pl, tsmatchers_1.is.object.matching({ v: { 0: tsmatchers_1.is.object, 1: tsmatchers_1.is.object, 2: tsmatchers_1.is.object, 3: tsmatchers_1.is.object }, n: 1 }));
                        }
                        else if (evtCount == 1) {
                            tsmatchers_1.assert("right update payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2', v: { name: 'simona', surname: 'altrini' }, n: 2 }));
                            done();
                        }
                        evtCount++;
                    });
                    return sendCommand(cc, 'sp', '/users');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return sendCommand(cc, 's', '/users/2', { name: 'simona', surname: 'altrini' }, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                });
            });
            it('Should notify deletes up', function (done) {
                var evtCount = 0;
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.connection.on('v', function (pl) {
                        if (evtCount == 0) {
                            tsmatchers_1.assert("right fetch payload", pl, tsmatchers_1.is.object.matching({ v: { 0: tsmatchers_1.is.object, 1: tsmatchers_1.is.object, 2: tsmatchers_1.is.object, 3: tsmatchers_1.is.object }, n: 1 }));
                        }
                        else if (evtCount == 1) {
                            tsmatchers_1.assert("right update payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2', v: null, n: 2 }));
                            done();
                        }
                        evtCount++;
                    });
                    return sendCommand(cc, 'sp', '/users');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return sendCommand(cc, 's', '/users/2', null, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                });
            });
            it('Should notify changes down to specific value', function (done) {
                var evtCount = 0;
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.connection.on('v', function (pl) {
                        if (evtCount == 0) {
                            tsmatchers_1.assert("right fetch payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2/name', v: 'simone', n: 1 }));
                        }
                        else if (evtCount == 1) {
                            tsmatchers_1.assert("right update payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2/name', v: 'simona', n: 2 }));
                            done();
                        }
                        evtCount++;
                    });
                    return sendCommand(cc, 'sp', '/users/2/name');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return sendCommand(cc, 's', '/users/2', { name: 'simona', surname: 'altrini' }, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                });
            });
            it('Should notify of delete down to specific value', function () {
                var evtCount = 0;
                var cc = null;
                var pkprom = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.connection.on('v', function (pl) {
                        pkprom.resolve();
                        if (evtCount == 0) {
                            tsmatchers_1.assert("right fetch payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2/name', v: 'simone', n: 1 }));
                        }
                        else if (evtCount == 1) {
                            tsmatchers_1.assert("right update payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2/name', v: null, n: 2 }));
                        }
                        evtCount++;
                    });
                    pkprom = extPromise();
                    return sendCommand(cc, 'sp', '/users/2/name');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return pkprom;
                }).then(function () {
                    pkprom = extPromise();
                    return sendCommand(cc, 's', '/users/2', null, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return pkprom;
                });
            });
            it('Should notify of delete of specific values', function () {
                var evtCount = 0;
                var cc = null;
                var pkprom = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.connection.on('v', function (pl) {
                        pkprom.resolve();
                        if (evtCount == 0) {
                            tsmatchers_1.assert("right fetch payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2/name', v: 'simone', n: 1 }));
                        }
                        else if (evtCount == 1) {
                            tsmatchers_1.assert("right update payload", pl, tsmatchers_1.is.object.matching({ p: '/users/2/name', v: null, n: 2 }));
                        }
                        evtCount++;
                    });
                    return sendCommand(cc, 'sp', '/users/2/name');
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return pkprom;
                }).then(function () {
                    pkprom = extPromise();
                    return sendCommand(cc, 's', '/users/2/name', null, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return pkprom;
                });
            });
            it('Should notify once', function () {
                var evts = [];
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.connection.on('v', function (pl) {
                        evts.push(pl);
                    });
                    return Promise.all([
                        sendCommand(cc, 'sp', '/users'),
                        sendCommand(cc, 'sp', '/users/2'),
                        sendCommand(cc, 'sp', '/users/2/addresses'),
                        sendCommand(cc, 'sp', '/users/2/addresses/0'),
                        sendCommand(cc, 'sp', '/users/2/addresses/0/name')
                    ]);
                }).then(function (ack) {
                    return sendCommand(cc, 's', '/users/2/addresses', { 0: { name: 'office', line: 'viale carso' } }, 2);
                }).then(function (ack) {
                    tsmatchers_1.assert('acked correctly', ack, 'k');
                    return wait(200);
                }).then(function () {
                    // TODO sending the right optimized event is hard, so for now we send all the events
                    tsmatchers_1.assert("sent all the events", evts, tsmatchers_1.is.array.withLength(10));
                    /*
                    assert("sent all the events", evts, is.array.withLength(6));
                    var lst = evts[5];
                    assert('update event is right', lst, is.object.matching({p:'/users/2/addresses/0/name',v:'office'}));
                    */
                });
            });
        });
        describe('Query >', function () {
            beforeEach(function () {
                return getConnectedClient().then(function (cc) {
                    var vals = [];
                    for (var i = 0; i < 10; i++) {
                        vals[i] = { str: 'a' + i, num: i, invstr: 'a' + (99 - i), invnum: 99 - i, nest: { num: i } };
                    }
                    return sendCommand(cc, 's', '/vals', vals, 2);
                });
            });
            it('Should find plain elements with query', function () {
                return getConnectedClient().then(function (cc) {
                    cc.eventCheck = checkEvents(cc.connection, [
                        {
                            event: 'v',
                            match: tsmatchers_1.is.object.matching({
                                p: '/users/0',
                                v: {
                                    name: 'simone',
                                    addresses: {
                                        0: tsmatchers_1.is.defined,
                                        1: tsmatchers_1.is.defined
                                    }
                                },
                                q: 'q1',
                                n: 1,
                                aft: null
                            })
                        },
                        {
                            event: 'v',
                            match: tsmatchers_1.is.object.matching({ p: '/users/2', v: tsmatchers_1.is.defined, q: 'q1', n: 1, aft: '/users/0' })
                        },
                        {
                            event: 'v',
                            match: tsmatchers_1.is.object.matching({ p: '/users/3', v: tsmatchers_1.is.defined, q: 'q1', n: 1, aft: '/users/2' })
                        },
                        {
                            event: 'qd',
                            match: tsmatchers_1.is.object.matching({ q: 'q1' })
                        }
                    ]);
                    var def = { id: 'q1', compareField: 'name', equals: 'simone', path: '/users' };
                    var state = new Broker_1.SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                });
            });
            it('Should return everything if unbounded', function () {
                return getConnectedClient().then(function (cc) {
                    var expect = [];
                    for (var i = 0; i < 10; i++) {
                        var aft = null;
                        if (i > 0)
                            aft = '/vals/' + (i - 1);
                        expect.push({ event: 'v', match: tsmatchers_1.is.object.matching({ p: '/vals/' + i, aft: aft, n: 1, q: 'q1' }) });
                    }
                    expect.push({ event: 'qd', match: tsmatchers_1.is.defined });
                    cc.eventCheck = checkEvents(cc.connection, expect);
                    var def = { id: 'q1', path: '/vals' };
                    var state = new Broker_1.SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                    //}).then((evts)=>{
                    //    console.log(evts);
                });
            });
            it('Should return nothing if nothing found', function () {
                return getConnectedClient().then(function (cc) {
                    var expect = [];
                    expect.push({ event: 'qd', match: tsmatchers_1.is.defined });
                    cc.eventCheck = checkEvents(cc.connection, expect);
                    var def = { id: 'q1', path: '/isnotthere' };
                    var state = new Broker_1.SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                    //}).then((evts)=>{
                    //    console.log(evts);
                });
            });
            it('Should sort correctly on number', function () {
                return getConnectedClient().then(function (cc) {
                    var expect = [];
                    for (var i = 9; i >= 0; i--) {
                        var aft = null;
                        if (i < 9)
                            aft = '/vals/' + (i + 1);
                        expect.push({ event: 'v', match: tsmatchers_1.is.object.matching({ p: '/vals/' + i, n: 1, aft: aft }) });
                    }
                    expect.push({ event: 'qd', match: tsmatchers_1.is.defined });
                    cc.eventCheck = checkEvents(cc.connection, expect);
                    var def = { id: 'q1', compareField: 'invnum', path: '/vals' };
                    var state = new Broker_1.SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                    //}).then((evts)=>{
                    //    console.log(evts);
                });
            });
            it('Should sort correctly on strings', function () {
                return getConnectedClient().then(function (cc) {
                    var expect = [];
                    for (var i = 9; i >= 0; i--) {
                        var aft = null;
                        if (i < 9)
                            aft = '/vals/' + (i + 1);
                        expect.push({ event: 'v', match: tsmatchers_1.is.object.matching({ p: '/vals/' + i, n: 1, aft: aft }) });
                    }
                    expect.push({ event: 'qd', match: tsmatchers_1.is.defined });
                    cc.eventCheck = checkEvents(cc.connection, expect);
                    var def = { id: 'q1', compareField: 'invstr', path: '/vals' };
                    var state = new Broker_1.SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                    //}).then((evts)=>{
                    //    console.log(evts);
                });
            });
            it('Should limit results', function () {
                return getConnectedClient().then(function (cc) {
                    var expect = [];
                    for (var i = 0; i < 5; i++) {
                        var aft = null;
                        if (i > 0)
                            aft = '/vals/' + (i - 1);
                        expect.push({ event: 'v', match: tsmatchers_1.is.object.matching({ p: '/vals/' + i, aft: aft, n: 1, q: 'q1' }) });
                    }
                    expect.push({ event: 'qd', match: tsmatchers_1.is.defined });
                    cc.eventCheck = checkEvents(cc.connection, expect);
                    var def = { id: 'q1', path: '/vals', limit: 5 };
                    var state = new Broker_1.SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                    //}).then((evts)=>{
                    //    console.log(evts);
                });
            });
            it('Should notify update of result in the query', function () {
                var cc = null;
                var extraMessage = false;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    var expect = [];
                    for (var i = 0; i < 5; i++) {
                        var aft = null;
                        if (i > 0)
                            aft = '/vals/' + (i - 1);
                        expect.push({ event: 'v', match: tsmatchers_1.is.object.matching({ p: '/vals/' + i, aft: aft, n: 1, q: 'q1' }) });
                    }
                    expect.push({ event: 'qd', match: tsmatchers_1.is.defined });
                    cc.eventCheck = checkEvents(cc.connection, expect);
                    return sendCommand(cc, 'sq', { id: 'q1', path: '/vals', limit: 5 });
                }).then(function (ack) {
                    tsmatchers_1.assert("Got ack from the query", ack, 'k');
                    return cc.eventCheck;
                }).then(function (evts) {
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        { event: 'v', match: tsmatchers_1.is.object.matching({ p: '/vals/3/name', v: 'simone', n: 2 }) }
                    ]);
                    return sendCommand(cc, 's', '/vals/3/name', 'simone', 2);
                }).then(function () {
                    return cc.eventCheck;
                }).then(function (evts) {
                    cc.eventCheck.stop();
                    cc.connection.on('v', function () {
                        extraMessage = true;
                    });
                    return sendCommand(cc, 's', '/vals/6/name', 'simone', 3);
                }).then(function () {
                    return wait(100);
                }).then(function () {
                    tsmatchers_1.assert("must not send a value object for objects outside the query", extraMessage, false);
                    cc.eventCheck = checkEvents(cc.connection, [
                        { event: 'v', match: tsmatchers_1.is.object.matching({ p: '/vals/3/name', v: null, n: 4 }) }
                    ]);
                    return sendCommand(cc, 's', '/vals/3/name', null, 4);
                }).then(function () {
                    return cc.eventCheck;
                });
            });
            it('Should notify of query entry/exit on equals condition change on set', function () {
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.eventCheck = checkEvents(cc.connection, [
                        {
                            event: 'v',
                            match: tsmatchers_1.is.object.matching({
                                p: '/users/1',
                                v: {
                                    name: 'sara',
                                },
                                q: 'q1',
                                n: 1,
                                aft: null
                            })
                        }
                    ]);
                    return sendCommand(cc, 'sq', { id: 'q1', path: '/users', compareField: 'name', equals: 'sara' });
                }).then(function (ack) {
                    tsmatchers_1.assert("Got ack from the query", ack, 'k');
                    return cc.eventCheck;
                }).then(function (evts) {
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        { event: 'v', match: tsmatchers_1.is.object.matching({ p: '/users/2', v: { name: 'sara' }, q: 'q1', n: 2 }) }
                    ]);
                    return sendCommand(cc, 's', '/users/2', { name: 'sara' }, 2);
                }).then(function () {
                    return cc.eventCheck;
                }).then(function (evts) {
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        { event: 'qx', match: tsmatchers_1.is.object.matching({ p: '/users/2', q: 'q1', n: 3 }) }
                    ]);
                    return sendCommand(cc, 's', '/users/2', { name: 'simone' }, 3);
                }).then(function () {
                    return cc.eventCheck;
                });
            });
            it('Should notify of query entry/exit on delete', function () {
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.eventCheck = checkEvents(cc.connection, [
                        {
                            event: 'v',
                            match: tsmatchers_1.is.object.matching({
                                p: '/users/1',
                                v: {
                                    name: 'sara',
                                },
                                q: 'q1',
                                n: 1,
                                aft: null
                            })
                        }
                    ]);
                    return sendCommand(cc, 'sq', { id: 'q1', path: '/users', compareField: 'name', equals: 'sara' });
                }).then(function (ack) {
                    tsmatchers_1.assert("Got ack from the query", ack, 'k');
                    return cc.eventCheck;
                }).then(function (evts) {
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        { event: 'qx', match: tsmatchers_1.is.object.matching({ p: '/users/1', q: 'q1', n: 2 }) }
                    ]);
                    return sendCommand(cc, 's', '/users/1', null, 2);
                }).then(function () {
                    return cc.eventCheck;
                });
            });
            it('Should notify of query entry/exit on equals condition change on nested set', function () {
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.eventCheck = checkEvents(cc.connection, [
                        {
                            event: 'v',
                            match: tsmatchers_1.is.object.matching({
                                p: '/users/1',
                                v: {
                                    name: 'sara',
                                },
                                q: 'q1',
                                n: 1,
                                aft: null
                            })
                        }
                    ]);
                    return sendCommand(cc, 'sq', { id: 'q1', path: '/users', compareField: 'name', equals: 'sara' });
                }).then(function (ack) {
                    tsmatchers_1.assert("Got ack from the query", ack, 'k');
                    return cc.eventCheck;
                }).then(function (evts) {
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        { event: 'v', match: tsmatchers_1.is.object.matching({ p: '/users/2', v: { name: 'sara' }, q: 'q1', n: 2 }) }
                    ]);
                    return sendCommand(cc, 's', '/users/2/name', 'sara', 2);
                }).then(function () {
                    return cc.eventCheck;
                }).then(function (evts) {
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        { event: 'qx', match: tsmatchers_1.is.object.matching({ p: '/users/2', q: 'q1', n: 3 }) }
                    ]);
                    return sendCommand(cc, 's', '/users/2/name', 'simone', 3);
                }).then(function () {
                    return cc.eventCheck;
                });
            });
            it('Should find results for query on nested', function () {
                var cc = null;
                return getConnectedClient().then(function (ncc) {
                    cc = ncc;
                    cc.eventCheck = checkEvents(cc.connection, [
                        {
                            event: 'v',
                            match: tsmatchers_1.is.object.matching({
                                p: '/vals/1',
                                v: {
                                    nest: {
                                        num: 1
                                    }
                                },
                                q: 'q1',
                                n: 1,
                                aft: null
                            })
                        }
                    ]);
                    return sendCommand(cc, 'sq', { id: 'q1', path: '/vals', compareField: 'nest/num', equals: 1 });
                }).then(function (ack) {
                    tsmatchers_1.assert("Got ack from the query", ack, 'k');
                    return cc.eventCheck;
                }).then(function (evts) {
                    cc.eventCheck.stop();
                });
            });
            // TODO check notification on change
            // TODO check entry/exit on range and limit
        });
    });
});
function wait(to) {
    return new Promise(function (res, rej) {
        setTimeout(function () { return res(null); }, to);
    });
}
function extPromise() {
    var extres = null;
    var extrej = null;
    var prom = new Promise(function (res, rej) {
        extres = res;
        extrej = rej;
    });
    prom.resolve = function (val) {
        extres(val);
    };
    prom.reject = function (err) { return extrej(err); };
    return prom;
}

//# sourceMappingURL=BrokerTests.js.map
