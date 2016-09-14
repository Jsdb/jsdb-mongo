import * as Mongo from 'mongodb';
import * as Debug from 'debug';

Debug.enable('tsdb:*');

import * as SocketIO from 'socket.io';
import * as SocketClient from 'socket.io-client';

import {Broker,AuthService,SimpleQueryDef,SimpleQueryState,Handler,Recomposer,Socket,LocalSocket} from '../main/Broker';
import * as Utils from '../main/Utils';

import {assert,is} from 'tsmatchers';
import {Matcher,matcherOrEquals} from 'tsmatchers/js/main/tsMatchers';


var mongoUrl = 'mongodb://localhost:27017/';

var socketURL = 'http://0.0.0.0:5000';


interface TestBroker {
    socket: SocketIO.Server;

    collectionDb: Mongo.Db;
    oplogDb: Mongo.Db;

    collection: Mongo.Collection;
    oplog: Mongo.Collection;

    auth :AuthService;

    collectionNs :string;

    started :boolean;
    startWait :Promise<any>[];

    handlers :{[index:string]:Handler};
    subscriptions :{[index:string]:{[index:number]:TestHandler}};
}

interface TestHandler {
    pathSubs :{[index:string]:boolean};
}

var socketServer :SocketIO.Server;
var localSocket :LocalSocket;

var useLocalSocket = true;

var lastBroker :Broker;
function getBroker() :Promise<Broker & TestBroker> {
    var proms :Promise<any>[] = [];
    if (lastBroker) proms.push(lastBroker.close());
    if (socketServer) socketServer.close();
    if (!useLocalSocket) {
        socketServer = SocketIO.listen(5000);
    } else {
        socketServer = null;
    }
    var brk = new Broker(socketServer, mongoUrl + 'test','bag1',mongoUrl + 'local');
    lastBroker = brk;
    proms.push(brk.start());
    return Promise.all(proms).then(()=>{
        var ret = <Broker & TestBroker>brk;
        return ret;
    });
}

var lastConn :SocketIOClient.Socket;

function getConnection() {
    if (lastConn) lastConn.close();
    if (useLocalSocket) {
        localSocket = new LocalSocket();
        lastBroker.handle(localSocket.server, null);
        return localSocket.client;
    } else {
        var socketOptions ={
            transports: ['websocket'],
            'force new connection': true
        };
        return lastConn = SocketClient.connect(socketURL, socketOptions);
    }
}

interface ConnectedClient {
    broker :Broker & TestBroker;
    connection :Socket;
    handler :Handler & TestHandler;
    eventCheck? :CheckPromise<SocketEvent[]>;
}

function getConnectedClient() :Promise<ConnectedClient> {
    return getBroker().then((brk)=>{
        var conn = getConnection();
        return new Promise<ConnectedClient>((res,rej)=>{
            var done = false;
            conn.on('aa', ()=>{
                if (done) return;
                done = true;
                var hnd = <Handler & TestHandler>brk.handlers[conn.id];
                res({broker:brk, connection:conn, handler:hnd});
            });
            conn.emit('aa');
        });
    })
}

var mongoDb :Mongo.Db;
var mongoColl :Mongo.Collection;
Mongo.MongoClient.connect(mongoUrl + 'test').then((db)=>{
    mongoDb = db;
    mongoColl = db.collection('bag1')
});


function sendCommand(cc :ConnectedClient, cmd :string, ...args :any[]) :Promise<string> {
    return new Promise<string>((res,rej) =>{
        var params :any[] = [cmd];
        params = params.concat(args);
        params.push((ack:string)=>{
            res(ack);
        });
        cc.connection.emit.apply(cc.connection, params);
    });
}

interface SocketEvent {
    event :string;
    match :any;
}

interface CheckPromise<T> extends Promise<T> {
    stop();
}

function checkEvents(conn :Socket, events :SocketEvent[], anyOrder = false) :CheckPromise<SocketEvent[]> {
    var ret :SocketEvent[] = [];
    var cbs = {};
    var cp = <CheckPromise<SocketEvent[]>>new Promise<SocketEvent[]>((res,err) => {
        var evtIds :{[index:string]:boolean} = {};
        for (var i = 0; i < events.length; i++) {
            evtIds[events[i].event] = true;
        }
        var acevt = 0;
        for (let k in evtIds) {
            var cb = (obj) => {
                try {
                    ret.push({event:k, match: obj});
                    assert("Got too many events", events, is.not.array.withLength(0));
                    if (anyOrder) {
                        var found = false;
                        var match :Matcher<any> = null;
                        for (var i = 0; i < events.length; i++) {
                            var acevobj = events[i];
                            if (acevobj.event != k) continue;
                            match = matcherOrEquals(acevobj.match);
                            if (match.matches(obj)) {
                                events.splice(i,1);
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            assert("There is a matching event", obj, match);
                        }
                    } else {
                        var acevobj = events.shift();
                        assert("Checking event " + (acevt++) + " of type " + acevobj.event, obj, acevobj.match);
                    }
                    if (events.length == 0) res(ret);
                } catch (e) {
                    console.log("Received events", ret);
                    err(e);
                }
            };
            conn.on(k, cb);
            cbs[k] = cb;
        }
    });
    cp.stop = ()=>{
        for (var k in cbs) {
            conn.removeListener(k, cbs[k]);
        }
    };
    return cp;
}


describe("Broker >", ()=>{
    describe("Basics >", ()=>{
        it('Should normalize paths', ()=>{
            var paths = [
                'ciao/mamma',
                '/ciao/mamma/',
                '/ciao/../mamma/',
                '//ciao///mamma/./'
            ];
            for (var i = 0; i < paths.length; i++) {
                assert("Checking path '" + paths[i] + "'", Utils.normalizePath(paths[i]), '/ciao/mamma');
            }
        });

        it('Should limitToChild paths', ()=>{
            assert('wrong subpath', Utils.limitToChild('/users/1/sub/name','/people'), is.falsey);
            assert('single element', Utils.limitToChild('/users/1','/users'), '/users/1');
            assert('one sub element', Utils.limitToChild('/users/1/sub','/users'), '/users/1');
            assert('two sub element', Utils.limitToChild('/users/1/sub/name','/users'), '/users/1');
        });

        it('Should create a broker', ()=>{
            return getBroker().then((brk)=>brk.close());
        });

        it('Should handle a connection', (done)=>{
            getBroker().then((brk)=>{;
                var conn = getConnection();
                assert("Returned a connection", conn, is.defined);
                conn.on('aa', ()=>{
                    assert("Handler is in place", brk.handlers, is.object.withKeys(conn.id));
                    var handler = brk.handlers[conn.id];
                    assert("Handler has right id", handler.id, conn.id);
                    conn.emit('pi',123, (resp)=>{
                        assert("responded to the ping", resp, 123);
                        done();
                    });
                });
                conn.emit('aa');
            });
        });

        describe('Local socket >', ()=>{
            it('Should send and receive', ()=>{
                var sock = new LocalSocket();

                assert("Has same id", sock.server.id.substr(2), sock.client.id);

                var clrecv :string[] = [];
                var srrecv :string[] = [];

                sock.client.on('test1',(val)=>clrecv.push('test1:' + val));
                sock.client.on('test2',(val)=>clrecv.push('test2:' + val));

                sock.server.on('test1',(val)=>srrecv.push('test1:' + val));
                sock.server.on('test2',(val)=>srrecv.push('test2:' + val));

                sock.client.emit('test1', 'ciao');
                sock.server.emit('test1', 'come va');
                sock.client.emit('test2', 'ok');

                assert("Server received messages", srrecv, is.array.equals(['test1:ciao','test2:ok']));
                assert("Client received messages", clrecv, is.array.equals(['test1:come va']));
            });

            it('Should obey callbacks', ()=>{
                var sock = new LocalSocket();

                sock.client.on('test1',(val,cb)=>{
                    assert("There is a callback", cb, is.function);
                    cb('kk');
                });
                
                var got :string = null;
                sock.server.emit('test1', 'ciao', (resp)=>{
                    got = resp;
                });

                assert("got reponse", got, 'kk');
            });
        });
    });

    describe("Writing >", ()=>{
        describe("Set >", ()=>{
            it('Should correctly unroll simple objects', ()=>{
                var brk = new Broker();

                var unroll :Object[] = [];
                brk.recursiveUnroll('/test/root', {a:1,b:{c:{d:1}}}, unroll);
                assert("right length of unroll", unroll, is.array.withLength(2));
                assert("has element for a:1", unroll, is.array.containing(is.object.matching({_id:'/test/root', a:1})));
                assert("has element for d:1", unroll, is.array.containing(is.object.matching({_id:'/test/root/b/c', d:1})));
            });
            it('Should write a primitive string',()=>{
                return mongoColl.deleteMany({}).then(()=>{
                    return getConnectedClient();
                }).then((cc)=>{
                    return sendCommand(cc, 's', '/test/data', 'ciao', 2);
                }).then((ack)=>{
                    assert("returned correct ack",ack,'k');
                    return mongoColl.find({}).toArray();
                }).then((data)=>{
                    assert("should exist only one data", data, is.array.withLength(1));
                    var rec = data[0];
                    assert("record is right", rec, is.object.matching({_id:'/test', data:'ciao'}));
                });
            });
            it('Should write a primitive number',()=>{
                return mongoColl.deleteMany({}).then(()=>{
                    return getConnectedClient();
                }).then((cc)=>{
                    return sendCommand(cc, 's', '/test/data', 100, 2);
                }).then((ack)=>{
                    assert("returned correct ack",ack,'k');
                    return mongoColl.find({}).toArray();
                }).then((data)=>{
                    assert("should exist only one data", data, is.array.withLength(1));
                    var rec = data[0];
                    assert("record is right", rec, is.object.matching({_id:'/test', data:100}));
                });
            });
            it('Should write a simple object',()=>{
                return mongoColl.deleteMany({}).then(()=>{
                    return getConnectedClient();
                }).then((cc)=>{
                    return sendCommand(cc, 's', '/testData', {a:1}, 2);
                }).then((ack)=>{
                    assert("returned correct ack",ack,'k');
                    return mongoColl.find({}).toArray();
                }).then((data)=>{
                    assert("should exist only one data", data, is.array.withLength(1));
                    var rec = data[0];
                    assert("record is right", rec, is.object.matching({_id:'/testData',a:1}));
                });
            });
            it('Should write a primitive in first level child',()=>{
                return mongoColl.deleteMany({}).then(()=>{
                    return getConnectedClient();
                }).then((cc)=>{
                    return sendCommand(cc, 's', '/test', 'ciao', 2);
                }).then((ack)=>{
                    assert("returned correct ack",ack,'k');
                    return mongoColl.find({}).toArray();
                }).then((data)=>{
                    assert("should exist only one data", data, is.array.withLength(1));
                    var rec = data[0];
                    assert("record is right", rec, is.object.matching({_id:'', test:'ciao'}));
                });
            });
            it('Should write a complex object',()=>{
                return mongoColl.deleteMany({}).then(()=>{
                    return getConnectedClient();
                }).then((cc)=>{
                    return sendCommand(cc, 's', '/user/1', {name:'simone',surname:'gianni',addresses:[{label:'home',line:'via tiburtina'},{label:'office',line:'viale carso'}]}, 2);
                }).then((ack)=>{
                    assert("returned correct ack",ack,'k');
                    return mongoColl.find({}).toArray();
                }).then((data)=>{
                    assert("should exist all the data", data, is.array.withLength(3));
                    assert("record for user is right", data, is.array.containing(is.strictly.object.matching({_id:'/user/1',name:'simone',surname:'gianni'})));
                    assert("record for home address", data, is.array.containing(is.strictly.object.matching({_id:'/user/1/addresses/0',label:'home',line:'via tiburtina'})));
                    assert("record for office address", data, is.array.containing(is.strictly.object.matching({_id:'/user/1/addresses/1',label:'office',line:'viale carso'})));
                });
            });
            it('Should preserve other leafs',()=>{
                var cc :ConnectedClient;
                return mongoColl.deleteMany({}).then(()=>{
                    return getConnectedClient();
                }).then((ncc)=>{
                    cc = ncc;
                    return sendCommand(cc, 's', '/test', {data1:'ciao',data2:'come',data3:'va'}, 2);
                }).then((ack)=>{
                    assert("returned correct ack",ack,'k');
                    return mongoColl.find({}).toArray();
                }).then((data)=>{
                    assert("should exist only one data", data, is.array.withLength(1));
                    var rec = data[0];
                    assert("record is right", rec, is.strictly.object.matching({_id:'/test', data1:'ciao',data2:'come',data3:'va'}));
                    return sendCommand(cc, 's', '/test/data2', 'quanto', 3);
                }).then((ack)=>{
                    assert("returned correct ack",ack,'k');
                    return mongoColl.find({}).toArray();
                }).then((data)=>{
                    assert("should exist only one data", data, is.array.withLength(1));
                    var rec = data[0];
                    assert("record is right", rec, is.strictly.object.matching({_id:'/test', data1:'ciao',data2:'quanto',data3:'va'}));
                });
            });
        });

        describe('Merge >', ()=>{
            beforeEach(()=>{
                return getConnectedClient().then((cc)=>{
                    return mongoColl.deleteMany({}).then(()=>cc);
                }).then((cc)=>{
                    return sendCommand(cc, 's', '/users', 
                    [
                        {
                            name:'simone',surname:'gianni',
                            addresses: [
                                {name:'home',line:'via tiburtina'},
                                {name:'office',line:'viale carso'}
                            ]
                        }
                        ,
                        {
                            name:'sara',surname:'gianni',
                            addresses: [
                                {name:'home',line:'via tiburtina'},
                                {name:'office',line:'via luca signorelli'}
                            ]
                        }
                    ], 1);
                });
            });

            it('Should correctly unroll deletes for simple objects', ()=>{
                var brk = new Broker();

                var unroll :Object[] = [];
                var deletes :string[] = [];
                brk.recursiveUnroll('/test/root', {a:1,b:{c:{d:1}},e:null,f:{g:null}}, unroll, deletes);

                assert("right length of unroll", unroll, is.array.withLength(2));
                assert("has element for a:1", unroll, is.array.containing(is.object.matching({_id:'/test/root', a:1})));
                assert("has element for d:1", unroll, is.array.containing(is.object.matching({_id:'/test/root/b/c', d:1})));

                assert("right length of deletes", deletes, is.array.withLength(2));
                assert("has deletes for e:null", deletes, is.array.containing('/test/root/e'));
                assert("has deletes for e:null", deletes, is.array.containing('/test/root/f/g'));
            });

            it('Should update simple object values', ()=>{
                return getConnectedClient().then((cc)=>{
                    return sendCommand(cc, 'm', '/users/0', {phone:'iphone',addresses:null,surname:null}, 2);
                }).then((ack)=>{
                    assert("returned correct ack",ack,'k');
                    return mongoColl.find({}).toArray();
                }).then((data)=>{
                    assert("should exist the right datas", data, is.array.withLength(4));
                    assert("record merged user is right", data, is.array.containing(is.strictly.object.matching({_id:'/users/0',phone:'iphone',name:'simone'})));
                    assert("record for user is right", data, is.array.containing(is.strictly.object.matching({_id:'/users/1',name:'sara',surname:'gianni'})));
                    assert("record for home address", data, is.array.containing(is.strictly.object.matching({_id:'/users/1/addresses/0',name:'home',line:'via tiburtina'})));
                    assert("record for office address", data, is.array.containing(is.strictly.object.matching({_id:'/users/1/addresses/1',name:'office',line:'via luca signorelli'})));
                });
            });
        });
    });

    describe('Deleting >', ()=>{
        it('Should delete the entire path given to set', ()=>{
            var cc :ConnectedClient = null;
            return mongoColl.deleteMany({}).then(()=>{
                return getConnectedClient();
            }).then((ncc)=>{
                cc = ncc;
                return sendCommand(cc, 's', '/user/1', {name:'simone',surname:'gianni',addresses:[{label:'home',line:'via tiburtina'},{label:'office',line:'viale carso'}]}, 2);
            }).then((ack)=>{
                assert("returned correct ack",ack,'k');
                return mongoColl.find({}).toArray();
            }).then((data)=>{
                assert("should exist all the data", data, is.array.withLength(3));
                return sendCommand(cc, 's', '/user/1', null, 3);
            }).then((ack)=>{
                assert("returned correct ack",ack,'k');
                return mongoColl.find({}).toArray();
            }).then((data)=>{
                assert("should have deleted some data", data, is.array.withLength(0));
            });
        });

        it('Should delete a sub path given to set', ()=>{
            var cc :ConnectedClient = null;
            return mongoColl.deleteMany({}).then(()=>{
                return getConnectedClient();
            }).then((ncc)=>{
                cc = ncc;
                return sendCommand(cc, 's', '/user/1', {name:'simone',surname:'gianni',addresses:[{label:'home',line:'via tiburtina'},{label:'office',line:'viale carso'}]}, 2);
            }).then((ack)=>{
                assert("returned correct ack",ack,'k');
                return mongoColl.find({}).toArray();
            }).then((data)=>{
                assert("should exist all the data", data, is.array.withLength(3));
                return sendCommand(cc, 's', '/user/1/addresses/1', null, 3);
            }).then((ack)=>{
                assert("returned correct ack",ack,'k');
                return mongoColl.find({}).toArray();
            }).then((data)=>{
                assert("should have deleted some data", data, is.array.withLength(2));
            });
        });

        it('Should delete a leaf', ()=>{
            var cc :ConnectedClient = null;
            return mongoColl.deleteMany({}).then(()=>{
                return getConnectedClient();
            }).then((ncc)=>{
                cc = ncc;
                return sendCommand(cc, 's', '/user/1', {name:'simone',surname:'gianni'}, 2);
            }).then((ack)=>{
                assert("returned correct ack",ack,'k');
                return mongoColl.find({}).toArray();
            }).then((data)=>{
                assert("should exist all the data", data, is.array.withLength(1));
                var rec = data[0];
                assert("object should match", rec, is.strictly.object.matching({_id:is.string,name:'simone',surname:'gianni'}));
                return sendCommand(cc, 's', '/user/1/name', null, 3);
            }).then((ack)=>{
                assert("returned correct ack",ack,'k');
                return mongoColl.find({}).toArray();
            }).then((data)=>{
                assert("should exist all the data", data, is.array.withLength(1));
                var rec = data[0];
                assert("object should match", rec, is.strictly.object.matching({_id:is.string,surname:'gianni'}));
            });
        });

        it('Should delete a sub path given as an empty object', ()=>{
            var cc :ConnectedClient = null;
            return mongoColl.deleteMany({}).then(()=>{
                return getConnectedClient();
            }).then((ncc)=>{
                cc = ncc;
                return sendCommand(cc, 's', '/user/1', {name:'simone',surname:'gianni',addresses:[{label:'home',line:'via tiburtina'},{label:'office',line:'viale carso'}]}, 2);
            }).then((ack)=>{
                assert("returned correct ack",ack,'k');
                return mongoColl.find({}).toArray();
            }).then((data)=>{
                assert("should exist all the data", data, is.array.withLength(3));
                return sendCommand(cc, 's', '/user/1/addresses', {}, 3);
            }).then((ack)=>{
                assert("returned correct ack",ack,'k');
                return mongoColl.find({}).toArray();
            }).then((data)=>{
                assert("should have deleted some data", data, is.array.withLength(1));
            });
        });

    });

    describe("Reading >", ()=>{
        beforeEach(()=>{
            return getConnectedClient().then((cc)=>{
                return mongoColl.deleteMany({}).then(()=>cc);
            }).then((cc)=>{
                return sendCommand(cc, 's', '/users', 
                [
                    {
                        name:'simone',surname:'gianni',
                        addresses: [
                            {name:'home',line:'via tiburtina'},
                            {name:'office',line:'viale carso'}
                        ]
                    }
                    ,
                    {
                        name:'sara',surname:'gianni',
                        addresses: [
                            {name:'home',line:'via tiburtina'},
                            {name:'office',line:'via luca signorelli'}
                        ]
                    }
                    ,
                    {name:'simone',surname:'altro'}
                    ,
                    {name:'simone',surname:'ultro'}
                    ,
                ], 1);
            });
        });

        it('Should correctly recompose objects', ()=>{
            var rec = new Recomposer('/users/1');

            rec.add({_id:'/users/1',name:'simone',surname:'gianni'});
            assert('basic composition is right', rec.get(), is.object.matching({name:'simone',surname:'gianni'}));

            rec.add({_id:'/users/1/phone', model:'iphone',year:2016});
            assert('sub composition is right', rec.get(), is.object.matching({phone:{model:'iphone',year:2016}}));

            rec.add({_id:'/users/1/addresses/0', name: "home", line: "via tiburtina"});
            assert('nested composition is right', rec.get(), is.object.matching({addresses:{0:{name: "home", line: "via tiburtina"}}}));

            rec = new Recomposer('/users/1');
            rec.add({_id:'/users/1/addresses/0', name: "home", line: "via tiburtina"});
            rec.add({_id:'/users/1/addresses/1', name: "office", line: "viale carso"});
            rec.add({_id:'/users/1',name:'simone',surname:'gianni'});

            assert('reverse composition is right', rec.get(), 
                is.object.matching({
                        name:'simone',surname:'gianni',
                        addresses: [
                            {name:'home',line:'via tiburtina'},
                            {name:'office',line:'viale carso'}
                        ]
                    })
            );
        });

        describe('Fetching >', ()=>{
            it('Should fetch a simple object', (done)=>{
                return getConnectedClient().then((cc)=>{
                    cc.connection.on('v',(pl)=>{
                        assert("right payload", pl, is.object.matching({p:'/users/2',v:{name:'simone',surname:'altro'},n:1}));
                        done();
                    });
                    return sendCommand(cc, 'sp', '/users/2');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                });
            });

            it('Should fetch a complex object', (done)=>{
                return getConnectedClient().then((cc)=>{
                    cc.connection.on('v',(pl)=>{
                        assert("right payload", pl, is.object.matching(
                        {
                            p:'/users/0',
                            v: {
                                name:'simone',surname:'gianni',
                                addresses: [
                                    {name:'home',line:'via tiburtina'},
                                    {name:'office',line:'viale carso'}
                                ]
                            },
                            n:1
                        }));
                        done();
                    });
                    return sendCommand(cc, 'sp', '/users/0');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                });
            });

            it('should fetch a specific value', (done)=>{
                return getConnectedClient().then((cc)=>{
                    cc.connection.on('v',(pl)=>{
                        assert("right payload", pl, is.object.matching({p:'/users/2/name',v:'simone',n:1}));
                        done();
                    });
                    return sendCommand(cc, 'sp', '/users/2/name');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                });
            });

            it('should fetch root', ()=>{
                var cc :ConnectedClient = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.eventCheck = checkEvents(cc.connection,
                    [
                        {
                            event: 'v',
                            match: is.object.matching({
                                v: {
                                    users: is.defined
                                },
                                n:1
                            })
                        }
                    ]);
                    return sendCommand(cc, 'sp', '/');
                }).then((ack)=>{
                    assert("Got ack from the sub", ack, 'k');
                    return cc.eventCheck;
                }).then((evts)=>{
                    console.log(evts);
                });
            })
        });

        describe("Path notify >", ()=>{
            it('Should notify of changes on a simple object', (done)=>{
                var evtCount = 0;
                var cc :ConnectedClient = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.connection.on('v',(pl)=>{
                        if (evtCount == 0) {
                            assert("right fetch payload", pl, is.object.matching({p:'/users/2',v:{name:'simone',surname:'altro'},n:1}));
                        } else if (evtCount == 1) {
                            assert("right update payload", pl, is.object.matching({p:'/users/2',v:{name:'simona',surname:'altrini'}, n:2}));
                            done();
                        }
                        evtCount++;
                    });
                    return sendCommand(cc, 'sp', '/users/2');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return sendCommand(cc, 's', '/users/2',{name:'simona',surname:'altrini'}, 2);
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                });
            });

            it('Should notify of changes done with merge', ()=>{
                var evts :any[] = [];
                var cc :ConnectedClient = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.connection.on('v',(pl)=>{
                        evts.push(pl);
                    });
                    return sendCommand(cc, 'sp', '/users/2');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return sendCommand(cc, 'm', '/users/2',{name:'simona',surname:null,phone:'iphone'}, 2);
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return wait(100);
                }).then(()=>{
                    assert("right number of events", evts, is.array.withLength(4));
                    assert("has event for name:simona", evts, is.array.containing(is.object.matching({"p":"/users/2","v":{"name":"simone","surname":"altro"},n:1})));
                    assert("has event for name:simona", evts, is.array.containing(is.object.matching({ p: '/users/2/name', v: 'simona',n:2 })));
                    assert("has event for surname:null", evts, is.array.containing(is.object.matching({ p: '/users/2/surname', v: null,n:2 })));
                    assert("has event for phone:iphone", evts, is.array.containing(is.object.matching({ p: '/users/2/phone', v: 'iphone',n:2 })));
                });
            });
            

            it('Should notify of changes on specific value', ()=>{
                var evtCount = 0;
                var cc :ConnectedClient = null;
                var pkprom :ExternalPromise<any> = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.connection.on('v',(pl)=>{
                        console.log('in on(v) ' + evtCount);
                        pkprom.resolve();
                        if (evtCount == 0) {
                            assert("right fetch payload", pl, is.object.matching({p:'/users/2/name',v:'simone',n:1}));
                        } else if (evtCount == 1) {
                            assert("right update payload", pl, is.object.matching({p:'/users/2/name',v:'sara',n:2}));
                        }
                        evtCount++;
                    });
                    pkprom = extPromise();
                    return sendCommand(cc, 'sp', '/users/2/name');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return pkprom;
                }).then(()=>{
                    pkprom = extPromise();
                    return sendCommand(cc, 's', '/users/2/name', 'sara', 2);
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return pkprom;
                });
            });

            it('Should notify changes up', (done)=>{
                var evtCount = 0;
                var cc :ConnectedClient = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.connection.on('v',(pl)=>{
                        if (evtCount == 0) {
                            assert("right fetch payload", pl, is.object.matching({v:{0:is.object, 1:is.object, 2:is.object, 3:is.object},n:1}));
                        } else if (evtCount == 1) {
                            assert("right update payload", pl, is.object.matching({p:'/users/2',v:{name:'simona',surname:'altrini'},n:2}));
                            done();
                        }
                        evtCount++;
                    });
                    return sendCommand(cc, 'sp', '/users');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return sendCommand(cc, 's', '/users/2',{name:'simona',surname:'altrini'}, 2);
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                });
            });

            it('Should notify deletes up', (done)=>{
                var evtCount = 0;
                var cc :ConnectedClient = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.connection.on('v',(pl)=>{
                        if (evtCount == 0) {
                            assert("right fetch payload", pl, is.object.matching({v:{0:is.object, 1:is.object, 2:is.object, 3:is.object},n:1}));
                        } else if (evtCount == 1) {
                            assert("right update payload", pl, is.object.matching({p:'/users/2',v:null,n:2}));
                            done();
                        }
                        evtCount++;
                    });
                    return sendCommand(cc, 'sp', '/users');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return sendCommand(cc, 's', '/users/2',null, 2);
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                });
            });

            it('Should notify changes down to specific value', (done)=>{
                var evtCount = 0;
                var cc :ConnectedClient = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.connection.on('v',(pl)=>{
                        if (evtCount == 0) {
                            assert("right fetch payload", pl, is.object.matching({p:'/users/2/name',v:'simone',n:1}));
                        } else if (evtCount == 1) {
                            assert("right update payload", pl, is.object.matching({p:'/users/2/name',v:'simona',n:2}));
                            done();
                        }
                        evtCount++;
                    });
                    return sendCommand(cc, 'sp', '/users/2/name');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return sendCommand(cc, 's', '/users/2',{name:'simona',surname:'altrini'}, 2);
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                });
            });

            it('Should notify of delete down to specific value', ()=>{
                var evtCount = 0;
                var cc :ConnectedClient = null;
                var pkprom :ExternalPromise<any> = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.connection.on('v',(pl)=>{
                        pkprom.resolve();
                        if (evtCount == 0) {
                            assert("right fetch payload", pl, is.object.matching({p:'/users/2/name',v:'simone',n:1}));
                        } else if (evtCount == 1) {
                            assert("right update payload", pl, is.object.matching({p:'/users/2/name',v:null,n:2}));
                        }
                        evtCount++;
                    });
                    pkprom = extPromise();
                    return sendCommand(cc, 'sp', '/users/2/name');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return pkprom;
                }).then(()=>{
                    pkprom = extPromise();
                    return sendCommand(cc, 's', '/users/2',null, 2);
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return pkprom;
                });
            });

            it('Should notify of delete of specific values', ()=>{
                var evtCount = 0;
                var cc :ConnectedClient = null;
                var pkprom :ExternalPromise<any> = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.connection.on('v',(pl)=>{
                        pkprom.resolve();
                        if (evtCount == 0) {
                            assert("right fetch payload", pl, is.object.matching({p:'/users/2/name',v:'simone',n:1}));
                        } else if (evtCount == 1) {
                            assert("right update payload", pl, is.object.matching({p:'/users/2/name',v:null,n:2}));
                        }
                        evtCount++;
                    });
                    return sendCommand(cc, 'sp', '/users/2/name');
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return pkprom;
                }).then(()=>{
                    pkprom = extPromise();
                    return sendCommand(cc, 's', '/users/2/name', null, 2);
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return pkprom;
                });
            });

            it('Should notify once', ()=>{
                var evts :any[] = [];
                var cc :ConnectedClient = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.connection.on('v',(pl)=>{
                        evts.push(pl);
                    });
                    return Promise.all([
                        sendCommand(cc, 'sp', '/users'),
                        sendCommand(cc, 'sp', '/users/2'),
                        sendCommand(cc, 'sp', '/users/2/addresses'),
                        sendCommand(cc, 'sp', '/users/2/addresses/0'),
                        sendCommand(cc, 'sp', '/users/2/addresses/0/name')
                    ]);
                }).then((ack)=>{
                    return sendCommand(cc, 's', '/users/2/addresses', {0:{name:'office',line:'viale carso'}}, 2);
                }).then((ack)=>{
                    assert('acked correctly', ack, 'k');
                    return wait(200);
                }).then(()=>{
                    // TODO sending the right optimized event is hard, so for now we send all the events
                    assert("sent all the events", evts, is.array.withLength(10));
                    /*
                    assert("sent all the events", evts, is.array.withLength(6));
                    var lst = evts[5];
                    assert('update event is right', lst, is.object.matching({p:'/users/2/addresses/0/name',v:'office'}));
                    */
                });
            });
        });

        describe('Query >', ()=>{

            beforeEach(()=>{
                return getConnectedClient().then((cc)=>{
                    var vals :any[] = [];
                    for (var i = 0; i < 10; i++) {
                        vals[i] = { str: 'a'+i, num: i, invstr: 'a'+(99-i), invnum: 99-i, nest: {num:i}}
                    }
                    return sendCommand(cc, 's', '/vals', vals, 2);
                });
            });

            it('Should find plain elements with query', ()=>{
                return getConnectedClient().then((cc)=>{
                    cc.eventCheck = checkEvents(cc.connection,
                    [
                        {
                            event: 'v',
                            match: is.object.matching({
                                p: '/users/0',
                                v: {
                                    name: 'simone',
                                    addresses: {
                                        0: is.defined,
                                        1: is.defined
                                    }
                                },
                                q: 'q1',
                                n: 1,
                                aft: null
                            })
                        }
                        ,
                        {
                            event: 'v',
                            match: is.object.matching({p:'/users/2', v:is.defined, q:'q1', n: 1, aft: '/users/0'})
                        }
                        ,
                        {
                            event: 'v',
                            match: is.object.matching({p:'/users/3', v:is.defined, q:'q1', n: 1, aft: '/users/2'})
                        }
                        ,
                        {
                            event: 'qd',
                            match: is.object.matching({q:'q1'})
                        }
                    ]);
                    var def = {id:'q1',compareField:'name',equals:'simone',path:'/users'};
                    var state = new SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                });
            });

            it('Should return everything if unbounded', ()=>{
                return getConnectedClient().then((cc)=>{
                    var expect :SocketEvent[] = [];
                    for (var i = 0; i < 10; i++) {
                        var aft = null;
                        if (i > 0) aft = '/vals/' + (i-1);
                        expect.push({event:'v', match: is.object.matching({p:'/vals/'+i, aft:aft, n: 1, q:'q1'})});
                    }
                    expect.push({event:'qd',match:is.defined});

                    cc.eventCheck = checkEvents(cc.connection, expect);
                    var def = {id:'q1',path:'/vals'};
                    var state = new SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                //}).then((evts)=>{
                //    console.log(evts);
                });
            });

            it('Should return nothing if nothing found', ()=>{
                return getConnectedClient().then((cc)=>{
                    var expect :SocketEvent[] = [];
                    expect.push({event:'qd',match:is.defined});

                    cc.eventCheck = checkEvents(cc.connection, expect);
                    var def = {id:'q1',path:'/isnotthere'};
                    var state = new SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                //}).then((evts)=>{
                //    console.log(evts);
                });
            });

            it('Should sort correctly on number', ()=>{
                return getConnectedClient().then((cc)=>{
                    var expect :SocketEvent[] = [];
                    for (var i = 9; i >= 0; i--) {
                        var aft = null;
                        if (i < 9) aft = '/vals/' + (i+1);
                        expect.push({event:'v', match: is.object.matching({p:'/vals/'+i, n: 1, aft:aft})});
                    }
                    expect.push({event:'qd',match:is.defined});

                    cc.eventCheck = checkEvents(cc.connection, expect);
                    var def = {id:'q1',compareField:'invnum',path:'/vals'};
                    var state = new SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                //}).then((evts)=>{
                //    console.log(evts);
                });
            });

            it('Should sort correctly on strings', ()=>{
                return getConnectedClient().then((cc)=>{
                    var expect :SocketEvent[] = [];
                    for (var i = 9; i >= 0; i--) {
                        var aft = null;
                        if (i < 9) aft = '/vals/' + (i+1);
                        expect.push({event:'v', match: is.object.matching({p:'/vals/'+i, n: 1, aft:aft})});
                    }
                    expect.push({event:'qd',match:is.defined});

                    cc.eventCheck = checkEvents(cc.connection, expect);
                    var def = {id:'q1',compareField:'invstr',path:'/vals'};
                    var state = new SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                //}).then((evts)=>{
                //    console.log(evts);
                });
            });

            it('Should limit results', ()=>{
                return getConnectedClient().then((cc)=>{
                    var expect :SocketEvent[] = [];
                    for (var i = 0; i < 5; i++) {
                        var aft = null;
                        if (i > 0) aft = '/vals/' + (i-1);
                        expect.push({event:'v', match: is.object.matching({p:'/vals/'+i, aft:aft, n: 1, q:'q1'})});
                    }
                    expect.push({event:'qd',match:is.defined});

                    cc.eventCheck = checkEvents(cc.connection, expect);
                    var def = {id:'q1',path:'/vals',limit:5};
                    var state = new SimpleQueryState(cc.handler, cc.broker, def);
                    cc.broker.query(state);
                    return cc.eventCheck;
                //}).then((evts)=>{
                //    console.log(evts);
                });
            });

            it('Should notify update of result in the query', ()=>{
                var cc :ConnectedClient = null;
                var extraMessage = false;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    var expect :SocketEvent[] = [];
                    for (var i = 0; i < 5; i++) {
                        var aft = null;
                        if (i > 0) aft = '/vals/' + (i-1);
                        expect.push({event:'v', match: is.object.matching({p:'/vals/'+i, aft:aft, n: 1, q:'q1'})});
                    }
                    expect.push({event:'qd',match:is.defined});

                    cc.eventCheck = checkEvents(cc.connection, expect);

                    return sendCommand(cc, 'sq', {id:'q1',path:'/vals',limit:5});
                }).then((ack)=>{
                    assert("Got ack from the query", ack, 'k');
                    return cc.eventCheck;
                }).then((evts)=>{
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        {event:'v', match: is.object.matching({p:'/vals/3/name',v:'simone', n: 2})}
                    ]);
                    return sendCommand(cc, 's', '/vals/3/name','simone', 2);
                }).then(()=>{
                    return cc.eventCheck;
                }).then((evts)=>{
                    cc.eventCheck.stop();
                    cc.connection.on('v', ()=>{
                        extraMessage = true;
                    });
                    return sendCommand(cc, 's', '/vals/6/name','simone', 3);
                }).then(()=>{
                    return wait(100);
                }).then(()=>{
                    assert("must not send a value object for objects outside the query", extraMessage, false);
                    cc.eventCheck = checkEvents(cc.connection, [
                        {event:'v', match: is.object.matching({p:'/vals/3/name',v:null, n: 4})}
                    ]);
                    return sendCommand(cc, 's', '/vals/3/name',null, 4);
                }).then(()=>{
                    return cc.eventCheck;
                });
            });

            it('Should notify of query entry/exit on equals condition change on set', ()=>{
                var cc :ConnectedClient = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.eventCheck = checkEvents(cc.connection,
                    [
                        {
                            event: 'v',
                            match: is.object.matching({
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
                    return sendCommand(cc, 'sq', {id:'q1',path:'/users',compareField:'name',equals:'sara'});
                }).then((ack)=>{
                    assert("Got ack from the query", ack, 'k');
                    return cc.eventCheck;
                }).then((evts)=>{
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        {event:'v', match: is.object.matching({p:'/users/2',v:{name:'sara'},q:'q1', n:2})}
                    ]);
                    return sendCommand(cc, 's', '/users/2', {name:'sara'}, 2);
                }).then(()=>{
                    return cc.eventCheck;
                }).then((evts)=>{
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        {event:'qx', match: is.object.matching({p:'/users/2',q:'q1',n:3})}
                    ]);
                    return sendCommand(cc, 's', '/users/2', {name:'simone'}, 3);
                }).then(()=>{
                    return cc.eventCheck;
                });
            });

            it('Should notify of query entry/exit on delete', ()=>{
                var cc :ConnectedClient = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.eventCheck = checkEvents(cc.connection,
                    [
                        {
                            event: 'v',
                            match: is.object.matching({
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
                    return sendCommand(cc, 'sq', {id:'q1',path:'/users',compareField:'name',equals:'sara'});
                }).then((ack)=>{
                    assert("Got ack from the query", ack, 'k');
                    return cc.eventCheck;
                }).then((evts)=>{
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        {event:'qx', match: is.object.matching({p:'/users/1',q:'q1',n:2})}
                    ]);
                    return sendCommand(cc, 's', '/users/1', null, 2);
                }).then(()=>{
                    return cc.eventCheck;
                });
            });

            it('Should notify of query entry/exit on equals condition change on nested set', ()=>{
                var cc :ConnectedClient = null;
                return getConnectedClient().then((ncc)=>{
                    cc = ncc;
                    cc.eventCheck = checkEvents(cc.connection,
                    [
                        {
                            event: 'v',
                            match: is.object.matching({
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
                    return sendCommand(cc, 'sq', {id:'q1',path:'/users',compareField:'name',equals:'sara'});
                }).then((ack)=>{
                    assert("Got ack from the query", ack, 'k');
                    return cc.eventCheck;
                }).then((evts)=>{
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        {event:'v', match: is.object.matching({p:'/users/2',v:{name:'sara'},q:'q1',n:2})}
                    ]);
                    return sendCommand(cc, 's', '/users/2/name', 'sara', 2);
                }).then(()=>{
                    return cc.eventCheck;
                }).then((evts)=>{
                    cc.eventCheck.stop();
                    cc.eventCheck = checkEvents(cc.connection, [
                        {event:'qx', match: is.object.matching({p:'/users/2',q:'q1',n:3})}
                    ]);
                    return sendCommand(cc, 's', '/users/2/name', 'simone', 3);
                }).then(()=>{
                    return cc.eventCheck;
                });
            });

            // TODO check notification on change

            // TODO check entry/exit on range and limit


        });
    });
});


function wait(to :number) :Promise<any> {
    return new Promise<any>((res,rej)=>{
        setTimeout(()=>res(null), to);
    });
}

interface ExternalPromise<T> extends Promise<T> {
    resolve(val? :T);
    reject(err :any);
}

function extPromise<T>() :ExternalPromise<T> {
    var extres :(val : T | Thenable<T>) => void = null;
    var extrej :(err :any) => void = null;
    var prom = <ExternalPromise<T>>new Promise<T>((res,rej) => {
        extres = res;
        extrej = rej;
    });
    prom.resolve = (val :T) => {
        extres(val);
    };
    prom.reject = (err :any)=>extrej(err);
    return prom;
}