
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

    getValue(url: string | string[]) :any {
        var ret = findChain(url, this.data, true, false);
        return ret.pop();
    }

    handleChange(path :string, val :any) {
        // Normalize the path to "/" by wrapping the val
        var nv :any = val;
        var sp = splitUrl(path);
        sp.splice(0,1);
        while (sp.length) {
            var nnv :any = {};
            nnv[sp.pop()] = nv;
            markIncomplete(nnv);
            nv = nnv;
        }

        this.recurseApplyBroadcast(nnv, this.data, null, '');

        /*
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
        */
    }

    recurseApplyBroadcast(newval :any, acval :any, parentval :any, path :string) :boolean {
        var leaf = Utils.leafPath(path);
        if (newval !== null && typeof(newval) === 'object') {
            var changed = false;
            // Change from native value to object
            if (typeof(acval) !== 'object') {
                changed = true;
                acval = {};
                parentval[leaf] = acval;
            }

            // Look children of the new value
            for (var k in newval) {
                if (k.charAt(0) == '$') continue;
                var newc = newval[k];

                var pre = acval[k];
                if (newc === null) {
                    // Explicit delete
                    var presnap = new RDb3Snap(pre, this, path+'/'+k);
                    if (this.recurseApplyBroadcast(newc, pre, acval, path +'/'+k)) {
                        this.broadcastChildRemoved(path, k, presnap);
                        changed = true;
                    }
                } else if (typeof(pre) === 'undefined') {
                    // Child added
                    pre = {};
                    acval[k] = pre;
                    changed = true;
                    this.recurseApplyBroadcast(newc, pre, acval, path +'/'+k);
                    this.broadcastChildAdded(path, k, acval[k]);
                } else {
                    // Maybe child changed
                    if (this.recurseApplyBroadcast(newc, pre, acval, path+'/'+k)) {
                        changed = true;
                        this.broadcastChildChanged(path, k, acval[k]);
                    }
                }
            }
            if (!isIncomplete(newval)) {
                // If newc is not incomplete, delete all the other children
                for (var k in acval) {
                    if (newval[k] === null || typeof(newval[k]) === 'undefined') {
                        var pre = acval[k];
                        var presnap = new RDb3Snap(pre, this, path+'/'+k);
                        if (this.recurseApplyBroadcast(null, pre, acval, path +'/'+k)) {
                            this.broadcastChildRemoved(path, k, presnap);
                            changed = true;
                        }
                    }
                }
            }
            if (changed) {
                this.broadcastValue(path, acval);
            }
            return changed;
        } else {
            if (parentval[leaf] != newval) {
                if (newval === null) {
                    delete parentval[leaf];
                    // TODO we should probably propagate the nullification downwards to trigger value changed on who's listening below us
                } else {
                    parentval[leaf] = newval;
                }
                this.broadcastValue(path, newval);
                return true;
            }
            return false;
        }
    }

    broadcastValue(path :string, val :any) {
        this.broadcast(path, 'value', ()=>val instanceof RDb3Snap ? val : new RDb3Snap(val, this, path));
    }

    broadcastChildAdded(path :string, child :string, val :any) {
        this.broadcast(path, 'child_added', ()=>val instanceof RDb3Snap ? val : new RDb3Snap(val, this, path+'/'+child));
    }

    broadcastChildChanged(path :string, child :string, val :any) {
        this.broadcast(path, 'child_changed', ()=>val instanceof RDb3Snap ? val : new RDb3Snap(val, this, path+'/'+child));
    }

    broadcastChildRemoved(path :string, child :string, val :any) {
        this.broadcast(path, 'child_removed', ()=>val instanceof RDb3Snap ? val : new RDb3Snap(val, this, path+'/'+child));
    }

    broadcast(path :string, type :string, snapProvider :()=>RDb3Snap) {
        var sub = this.subscriptions[path];
        if (!sub) return;
        var handlers = sub.findByType(type);
        if (handlers.length == 0) return;
        var snap = snapProvider();
        for (var i = 0; i < handlers.length; i++) {
            handlers[i].callback(snap, null);
        }
    }

}

export class Subscription {

    constructor(private root :RDb3Root, private path :string) {

    }

    cbs: Handler[] = [];

    add(cb: Handler) {
        this.cbs.push(cb);
    }

    remove(cb: Handler) {
        this.cbs = this.cbs.filter((ocb) => ocb !== cb);
    }

    findByType(evtype :string) :Handler[] {
        return this.cbs.filter((ocb)=>ocb.eventType==evtype);
    }

}

export abstract class Handler {
    public eventType: string;

    private initing = false;

    constructor(
        public callback: (dataSnapshot: RDb3Snap, prevChildName?: string) => void,
        public context: Object,
        public tree: RDb3Tree
    ) {
        this.hook();
        this.init();
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

    abstract init() :void;
}

class ValueCbHandler extends Handler {
    init() {
        this.eventType = 'value';
        this.callback(new RDb3Snap(this.getValue(), this.tree.root, this.tree.url));
    }
}

class ChildAddedCbHandler extends Handler {
    init() {
        this.eventType = 'child_added';
        var acv = this.getValue();
        var mysnap = new RDb3Snap(this.getValue(), this.tree.root, this.tree.url);
        var prek :string = null;
        mysnap.forEach((cs)=>{
            this.callback(cs,prek);
            prek = cs.key();
            return false;
        });
    }
}

class ChildRemovedCbHandler extends Handler {
    init() {
        this.eventType = 'child_removed';
        // This event never triggers on init
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

class ChildChangedCbHandler extends Handler {
    init() {
        this.eventType = 'child_changed';
        // This event never triggers on init
    }
}

interface CbHandlerCtor {
    new (
        callback: (dataSnapshot: RDb3Snap, prevChildName?: string) => void,
        context: Object,
        tree: RDb3Tree
    ): Handler;
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
        private url: string,
        reclone = true
    ) {
        if (data != null && typeof (data) !== undefined && reclone) {
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
        return new RDb3Snap(subs.pop(), this.root, this.url + Utils.normalizePath(childPath), false);
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

    private cbs: Handler[] = [];
    private qsub: QuerySubscription = null;

    getSubscription(): Subscription {
        return this.qlistener || this.root.subscribe(this.url);
    }

    on(eventType: string, callback: (dataSnapshot: RDb3Snap, prevChildName?: string) => void, cancelCallback?: (error: any) => void, context?: Object): (dataSnapshot: RDb3Snap, prevChildName?: string) => void {
        var ctor: CbHandlerCtor = (<any>cbHandlers)[eventType];
        if (!ctor) throw new Error("Cannot find event " + eventType);
        var handler = new ctor(callback, context, this);
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