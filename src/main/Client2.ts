
import * as SocketIO from 'socket.io-client';

import * as Utils from './Utils';

type BroadcastCb = (sub :Subscription, acpath :string, acval:any)=>void;

export class RDb3Root {

    constructor(private sock :SocketIO.Socket, private baseUrl :string) {

    }

    private subscriptions :{[index:string]:Subscription} = {};
    private data :any = {};

    getUrl(url: string): RDb3Tree {
        return new RDb3Tree(this, this.makeRelative(url));
    }
    makeRelative(url: string): string {
        if (url.indexOf(this.baseUrl) != 0) return url;
        return "/" + url.substr(this.baseUrl.length);
    }
    makeAbsolute(url: string): string {
        return this.baseUrl + this.makeRelative(url);
    }

    isReady(): boolean {
        return true;
    }

    whenReady(): Promise<any> {
        return Promise.resolve();
    }

    subscribe(path :string) :Subscription {
        path = Utils.normalizePath(path);
        var sub = this.subscriptions[path];
        if (!sub) {
            this.subscriptions[path] = sub = new Subscription(this, path);
        }
        return sub;
    }

    unsubscribe(path :string) {
        delete this.subscriptions[path];
    }

    private broadcast(path :string, val :any, cb :BroadcastCb) {
        this.broadcastDown(path, val, cb);
        var sub = Utils.leafPath(path);
        var subv :any = {};
        subv[sub] = val;
        markIncomplete(subv);
        this.broadcastUp(Utils.parentPath(path), subv, cb);
    }

    private broadcastDown(path :string, val :any, cb :BroadcastCb) {
        if (val == null) {
            for (var k in this.subscriptions) {
                if (k.indexOf(path) == 0) {
                    this.broadcastToHandlers(k, null, cb);
                }
            }
        }
        if (typeof(val) == 'object' || typeof(val) == 'function') {
            for (var k in val) {
                this.broadcastDown(path + '/' + k, val[k], cb);
            }
        }
        this.broadcastToHandlers(path, val, cb);
    }

    private broadcastUp(path :string, val :any, cb :BroadcastCb) {
        if (!path) return;
        this.broadcastToHandlers(path, val, cb);
        if (path.length == 0) return;
        var sub = Utils.leafPath(path);
        var subv :any = {};
        subv[sub] = val;
        markIncomplete(subv);
        this.broadcastUp(Utils.parentPath(path), subv, cb);
    }

    private broadcastToHandlers(acpath :string, acval :any, cb :BroadcastCb) {
        var sub = this.subscriptions[acpath];
        if (!sub) return;
        // TODO get the previous value from local copy of data
        cb(sub, acpath, acval);
    }

    getValue(url: string | string[]) :any {
        var ret = findChain(url, this.data, true, false);
        return ret.pop();
    }

    handleChange(path :string, val :any) {
        // Find involved events
        var events :HandlerTrigger[] = [];
        this.broadcast(path, val, (sub, spath, acval) => {
            sub.willTrigger(spath, acval, events);
        });

        // Set the data to local snapshot
        var sp = splitUrl(path);
        var dataChain = findChain(sp, this.data, false, true);
        var ac = dataChain.pop();
        var k = sp[sp.length - 1];
        var oldVal = ac[k];
        if (val == null || typeof (val) == 'undefined') {
            delete ac[k];
        } else {
            ac[k] = val;
        }

        for (var i = 0; i < events.length; i++) {
            events[i]();
        }
    }

}

export class Subscription {

    constructor(private root :RDb3Root, private path :string) {

    }

    cbs: Handler[] = [];
    endCbs: Handler[] = [];

    add(cb: Handler) {
        this.cbs.push(cb);
        cb.init();
    }

    addEnd(cb: Handler) {
        this.endCbs.push(cb);
        cb.init();
    }

    remove(cb: Handler) {
        this.cbs = this.cbs.filter((ocb) => ocb !== cb);
        this.endCbs = this.endCbs.filter((ocb) => ocb !== cb);
    }

    willTrigger(fullpath :string, val :any, events :HandlerTrigger[]) {
        for (var i = 0; i < this.cbs.length; i++) {
            this.cbs[i].willTrigger(fullpath, val, events);
        }
        for (var i = 0; i < this.endCbs.length; i++) {
            this.endCbs[i].willTrigger(fullpath, val, events);
        }
    }

}

export type HandlerTrigger = () => void;

export interface Handler {
    init() :void;
    willTrigger(fullpath :string, val :any, trigger :HandlerTrigger[]) :void;
}



export abstract class BaseHandler implements Handler {
    public eventType: string;

    private initing = false;

    constructor(
        public callback: (dataSnapshot: RDb3Snap, prevChildName?: string) => void,
        public context: Object,
        public tree: RDb3Tree
    ) {
        this.hook();
    }

    matches(eventType?: string, callback?: (dataSnapshot: RDb3Snap, prevChildName?: string) => void, context?: Object) {
        if (context) {
            return this.eventType == eventType && this.callback === callback && this.context === context;
        } else if (callback) {
            return this.eventType == eventType && this.callback === callback;
        } else {
            return this.eventType == eventType;
        }
    }

    hook() {
        this.tree.getSubscription().add(this);
    }

    decommission() {
        this.tree.getSubscription().remove(this);
    }

    protected getValue() :any {
        if (this.initing) return undefined;
        return this.tree.root.getValue(this.tree.url);
    }

    abstract willTrigger(fullpath :string, val :any, trigger :HandlerTrigger[]) :void;

    // TODO properly implement init hare and in events
    init() {
        try {
            var myval = this.getValue();
            this.initing = true;
            var fns :HandlerTrigger[] = [];
            this.willTrigger(null, myval, fns);
            this.initing = false;
            for (var i = 0; i < fns.length; i++) fns[i]();
        } finally {
            this.initing = false;
        }
    }

}

class ValueCbHandler extends BaseHandler {
    hook() {
        this.tree.getSubscription().addEnd(this);
    }

    init() {
        this.callback(new RDb3Snap(this.getValue(), this.tree.root, this.tree.url));
    }

    // Value always trigger, whatever happened
    willTrigger(fullpath :string, val :any, triggers :HandlerTrigger[]) { 
        triggers.push(()=>this.callback(new RDb3Snap(this.getValue(), this.tree.root, this.tree.url)));
    }

}

class ChildAddedCbHandler extends BaseHandler {

    willTrigger(fullpath :string, val :any, triggers :HandlerTrigger[]) {
        if (typeof(val) != 'object') return;
        var acval = this.getValue();
        for (var k in val) {
            if (!acval || !acval[k]) {
                triggers.push(this.makeTrigger(k));
            }
        }
    }

    private makeTrigger(k :string) {
        return ()=>{
            var mysnap = new RDb3Snap(this.getValue(), this.tree.root, this.tree.url);
            this.callback(mysnap.child(k));
        };
    }

}

class ChildRemovedCbHandler extends BaseHandler {

    // This event never triggers on init
    init() {}


    willTrigger(fullpath :string, val :any, triggers :HandlerTrigger[]) :void {
        var myval = this.getValue();
        if (!myval || typeof(myval) != 'object') return;

        var mysnap = new RDb3Snap(this.getValue(), this.tree.root, this.tree.url);
        if (isIncomplete(val)) {
            for (var k in myval) {
                if (val[k] === null) {
                    triggers.push(this.makeTrigger(mysnap.child(k)))
                }
            }
        } else {
            for (var k in myval) {
                if (!val || !val[k]) {
                    triggers.push(this.makeTrigger(mysnap.child(k)))
                }
            }
        }
    }

    private makeTrigger(childSnap :RDb3Snap) {
        return ()=>{
            this.callback(childSnap);
        };
    }

}

/*
class ChildMovedCbHandler extends Handler {
    trigger(oldVal: any, newVal: any) {
        if (typeof (newVal) !== 'object') return;
        if (typeof (oldVal) !== 'object') return;

        // TODO ordering
        var oks = getKeysOrdered(oldVal);
        var nks = getKeysOrdered(newVal);

        var mysnap = new RDb3Snap(newVal, this.tree.root, this.tree.url);

        var oprek: string = null;
        for (var i = 0; i < oks.length; i++) {
            var k = oks[i];
            var npos = nks.indexOf(k);
            if (npos < 0) continue;
            var nprek = npos == 0 ? null : nks[npos - 1];
            if (nprek != oprek) {
                this.callback(mysnap.child(k), nprek);
            }
            oprek = k;
        }
    }
}
*/

class ChildChangedCbHandler extends BaseHandler {

    willTrigger(fullpath :string, val :any, triggers :HandlerTrigger[]) :void {
        if (typeof(val) != 'object') return;
        var myval = this.getValue();
        if (typeof(myval) != 'object') return;
        for (var k in val) {
            if (val[k] && myval[k]) triggers.push(this.makeTrigger(k));
        }
    }

    private makeTrigger(k :string) {
        return ()=>{
            var mysnap = new RDb3Snap(this.getValue(), this.tree.root, this.tree.url);
            this.callback(mysnap.child(k));
        };
    }
}

interface CbHandlerCtor {
    new (
        callback: (dataSnapshot: RDb3Snap, prevChildName?: string) => void,
        context: Object,
        tree: RDb3Tree
    ): BaseHandler;
}

var cbHandlers = {
    value: ValueCbHandler,
    child_added: ChildAddedCbHandler,
    child_removed: ChildRemovedCbHandler,
    //child_moved: ChildMovedCbHandler,
    child_changed: ChildChangedCbHandler
}


export class RDb3Snap {
    constructor(
        private data: any,
        private root: RDb3Root,
        private url: string
    ) {
        if (data != null && typeof (data) !== undefined) {
            this.data = JSON.parse(JSON.stringify(data));
            if (data['$sorter']) this.data['$sorter'] = data['$sorter'];
        } else {
            this.data = data;
        }
    }

    exists(): boolean {
        return typeof (this.data) !== 'undefined' && this.data !== null;
    }

    val(): any {
        if (!this.exists()) return null;
        return JSON.parse(JSON.stringify(this.data));
    }
    child(childPath: string): RDb3Snap {
        var subs = findChain(childPath, this.data, true, false);
        return new RDb3Snap(subs.pop(), this.root, this.url + '/' + Utils.normalizePath(childPath));
    }

    // TODO ordering
    forEach(childAction: (childSnapshot: RDb3Snap) => void): boolean;
    forEach(childAction: (childSnapshot: RDb3Snap) => boolean): boolean {
        if (!this.exists()) return;
        var ks = getKeysOrdered(this.data);
        for (var i = 0; i < ks.length; i++) {
            if (childAction(this.child(ks[i]))) return true;
        }
        return false;
    }

    key(): string {
        return this.url.split('/').pop() || '';
    }

    ref(): RDb3Tree {
        return this.root.getUrl(this.url);
    }
}


type SortFunction = (a: any, b: any) => number;

function getKeysOrdered(obj: any, fn?: SortFunction): string[] {
    fn = fn || obj['$sorter'];
    var sortFn: SortFunction = null;
    if (fn) {
        sortFn = (a, b) => {
            return fn(obj[a], obj[b]);
        };
    }
    var ks = Object.getOwnPropertyNames(obj);
    var ret: string[] = [];
    for (var i = 0; i < ks.length; i++) {
        if (ks[i].charAt(0) == '$') continue;
        ret.push(ks[i]);
    }
    ret = ret.sort(sortFn);
    return ret;
}



function splitUrl(url: string) {
    return Utils.normalizePath(url).split('/');
}

function findChain<T>(url: string | string[], from: T, leaf = true, create = false): T[] {
    var sp: string[];
    if (typeof (url) === 'string') {
        sp = splitUrl(<string>url);
    } else {
        sp = <string[]>url;
    }
    var to = sp.length;
    if (!leaf) to--;
    var ret: T[] = [];
    var ac: any = from;
    ret.push(ac);
    for (var i = 0; i < to; i++) {
        if (sp[i].length == 0) continue;
        if (!create && typeof (ac) !== 'object') {
            ret.push(undefined);
            break;
            //return [undefined];
        }
        var pre = ac;
        ac = ac[sp[i]];
        if (typeof (ac) === 'undefined') {
            if (!create) {
                ret.push(undefined);
                break;
                //return [undefined];
            }
            ac = <T>{};
            pre[sp[i]] = ac;
        }
        ret.push(ac);
    }
    return ret;
}

function markIncomplete(obj :any) {
    Object.defineProperty(obj, '$i', {enumerable:false, value:true});
}

function isIncomplete(obj :any) :boolean {
    return !!obj['$i'];
}


export class RDb3Tree {

    constructor(
        public root: RDb3Root,
        public url: string
    ) {

    }

    private cbs: BaseHandler[] = [];
    private qsub: QuerySubscription = null;

    getSubscription(): Subscription {
        return this.qlistener || this.root.subscribe(this.url);
    }

    on(eventType: string, callback: (dataSnapshot: RDb3Snap, prevChildName?: string) => void, cancelCallback?: (error: any) => void, context?: Object): (dataSnapshot: RDb3Snap, prevChildName?: string) => void {
        var ctor: CbHandlerCtor = (<any>cbHandlers)[eventType];
        if (!ctor) throw new Error("Cannot find event " + eventType);
        var handler = new ctor(callback, context, this);
        handler.eventType = eventType;
        this.cbs.push(handler);
        return callback;
    }

    off(eventType?: string, callback?: (dataSnapshot: RDb3Snap, prevChildName?: string) => void, context?: Object): void {
        this.cbs = this.cbs.filter((ach) => {
            if (ach.matches(eventType, callback, context)) {
                ach.decommission();
                return true;
            }
            return false;
        });
    }


    once(eventType: string, successCallback: (dataSnapshot: RDb3Snap) => void, context?: Object): void;
    once(eventType: string, successCallback: (dataSnapshot: RDb3Snap) => void, failureCallback?: (error: any) => void, context?: Object): void {
        var fn = this.on(eventType, (ds) => {
            this.off(eventType, fn);
            successCallback(ds);
        }, (err) => {
            if (failureCallback && context) {
                failureCallback(err);
            }
        }, context || failureCallback);
    }
    

}