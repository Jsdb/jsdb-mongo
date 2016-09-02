
import * as SocketIOClient from 'socket.io-client';

import * as Utils from './Utils';

type BroadcastCb = (sub :Subscription, acpath :string, acval:any)=>void;

export class RDb3Root {

    constructor(private sock :SocketIOClient.Socket, private baseUrl :string) {
        if (sock) {
            sock.on('v', (msg:any)=>this.receivedValue(msg));
            sock.on('qd', (msg:any)=>this.receivedQueryDone(msg));
            sock.on('qx', (msg:any)=>this.receivedQueryExit(msg));
        }
    }

    private subscriptions :{[index:string]:Subscription} = {};
    private data :any = {};
    private queries :{[index:string]:QuerySubscription} = {};

    private doneProm :Promise<any> = null;

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
        if (this.doneProm) return this.doneProm;
        if (this.sock) {
            return new Promise((res,err)=>{
                var to = setTimeout(()=>err(new Error('Timeout')), 30000);
                this.sock.on('aa', ()=>{
                    clearTimeout(to);
                    res();
                });
            });
        } else {
            return Promise.resolve();
        }
    }

    receivedValue(msg :any) {
        this.handleChange(msg.p, msg.v);
        if (msg.q) {
            var val = msg.v;
            val.$l = true;
            this.handleQueryChange(msg.q, msg.p, val);
        }
    }

    receivedQueryDone(msg :any) {
        var qdef = this.queries[msg.q];
        this.handleQueryChange(msg.q, qdef.path, {$i:true});
    }

    receivedQueryExit(msg :any) {
        var qdef = this.queries[msg.q];
        this.handleQueryChange(msg.q, msg.p, null);
    }

    send(...args :any[]) {
        if (this.sock) {
            this.sock.emit.apply(this.sock, args);
        }
    }

    sendSubscribe(path :string) {
        this.send('sp', path);
    }

    sendUnsubscribe(path :string) {
        this.send('up', path);
    }

    sendSubscribeQuery(def :QuerySubscription) {
        this.send('sq', def);
    }

    sendUnsubscribeQuery(id :string) {
        this.send('uq', id);
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
        this.sendUnsubscribe(path);
        delete this.subscriptions[path];
        var ch = findChain(Utils.parentPath(path), this.data);
        var leaf = Utils.leafPath(path);
        var lst = ch.pop();
        delete lst[leaf];
    }

    subscribeQuery(query :QuerySubscription) {
        this.queries[query.id] = query;
        this.subscriptions['/q' + query.id] = query; 
    }

    unsubscribeQuery(id :string) {
        this.sendUnsubscribeQuery(id);
        delete this.queries[id];
        delete this.subscriptions['/q' + id];
        delete this.data['q' + id];
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

        this.recurseApplyBroadcast(nv, this.data, null, '');
    }

    handleQueryChange(id :string, path :string, val :any) {
        var def = this.queries[id];
        if (!def) {
            // TODO stale query, unsubscribe?
            return;
        }
        var subp = path.substr(def.path.length);
        var nv :any = val;
        var sp = splitUrl(subp);
        sp.splice(0,1);
        while (sp.length) {
            var nnv :any = {};
            nnv[sp.pop()] = nv;
            markIncomplete(nnv);
            nv = nnv;
        }

        if (!this.data['q'+id]) this.data['q'+id] = {};
        nv['$sorter'] = this.data['q'+id]['$sorter'] = def.makeSorter();
        this.recurseApplyBroadcast(nv, this.data['q'+id], this.data, '/q'+id, def.path);

        if (def.limit) {
            var acdata = this.data['q'+id];
            var ks = getKeysOrdered(acdata);
            if (ks.length > def.limit) {
                var torem :any = {};
                while (ks.length > def.limit) {
                    var k = def.limitLast ? ks.shift() : ks.pop();
                    torem[k] = null;
                }
                markIncomplete(torem);
                this.recurseApplyBroadcast(torem, this.data['q'+id], this.data, '/q'+id, def.path);
            }
        }
    }

    recurseApplyBroadcast(newval :any, acval :any, parentval :any, path :string, queryPath? :string) :boolean {
        var leaf = Utils.leafPath(path);
        if (newval !== null && typeof(newval) === 'object') {
            var changed = false;
            // Change from native value to object
            if (!acval || typeof(acval) !== 'object') {
                changed = true;
                acval = {};
                parentval[leaf] = acval;
            }

            // Look children of the new value
            var nks = getKeysOrdered(newval);
            for (var nki = 0; nki < nks.length; nki++) {
                var k = nks[nki];
                if (k.charAt(0) == '$') continue;
                var newc = newval[k];

                var pre = acval[k];
                if (newc === null) {
                    // Explicit delete
                    var presnap = new RDb3Snap(pre, this, (queryPath||path)+'/'+k);
                    if (this.recurseApplyBroadcast(newc, pre, acval, path +'/'+k)) {
                        this.broadcastChildRemoved(path, k, presnap, queryPath);
                        // TODO consider sorting and previous key, removing an element makes the next one to move "up" in the list
                        //this.broadcastChildMoved(path, k, acval[k]);
                        changed = true;
                    }
                } else if (typeof(pre) === 'undefined') {
                    // Child added
                    pre = {};
                    acval[k] = pre;
                    changed = true;
                    this.recurseApplyBroadcast(newc, pre, acval, path +'/'+k);
                    this.broadcastChildAdded(path, k, acval[k], queryPath, findPreviousKey(acval, k));
                } else {
                    // Maybe child changed
                    var prepre = findPreviousKey(acval, k);
                    if (this.recurseApplyBroadcast(newc, pre, acval, path+'/'+k)) {
                        changed = true;
                        // TODO consider sorting and previous key
                        var acpre = findPreviousKey(acval, k);
                        this.broadcastChildChanged(path, k, acval[k], queryPath, acpre);
                        if (prepre != acpre) {
                            this.broadcastChildMoved(path, k, acval[k], queryPath, acpre);
                        }
                    }
                }
            }
            if (!isIncomplete(newval)) {
                // If newc is not incomplete, delete all the other children
                for (var k in acval) {
                    if (newval[k] === null || typeof(newval[k]) === 'undefined') {
                        var pre = acval[k];
                        var presnap = new RDb3Snap(pre, this, (queryPath || path) + '/' + k);
                        if (this.recurseApplyBroadcast(null, pre, acval, path +'/'+k)) {
                            this.broadcastChildRemoved(path, k, presnap, queryPath);
                            // TODO consider sorting and previous key, removing an element makes the next one to move "up" in the list
                            //this.broadcastChildMoved(path, k, acval[k]);
                            changed = true;
                        }
                    }
                }
            }
            if ((changed && !newval.$l) || newval.$d) {
                this.broadcastValue(path, acval, queryPath);
            }
            return changed;
        } else {
            if (parentval[leaf] != newval) {
                if (newval === null) {
                    delete parentval[leaf];
                    // TODO we should probably propagate the nullification downwards to trigger value changed on who's listening below us
                    // Except when in a query, removal from a query deos not mean the element does not exist anymore
                } else {
                    parentval[leaf] = newval;
                }
                this.broadcastValue(path, newval, queryPath);
                return true;
            }
            return false;
        }
    }

    broadcastValue(path :string, val :any, queryPath :string) {
        this.broadcast(path, 'value', ()=>val instanceof RDb3Snap ? val : new RDb3Snap(val, this, queryPath || path));
    }

    broadcastChildAdded(path :string, child :string, val :any, queryPath :string, prevChildName? :string) {
        this.broadcast(path, 'child_added', ()=>val instanceof RDb3Snap ? val : new RDb3Snap(val, this, (queryPath || path)+'/'+child), prevChildName);
    }

    broadcastChildChanged(path :string, child :string, val :any, queryPath :string, prevChildName? :string) {
        this.broadcast(path, 'child_changed', ()=>val instanceof RDb3Snap ? val : new RDb3Snap(val, this, (queryPath || path)+'/'+child), prevChildName);
    }

    broadcastChildMoved(path :string, child :string, val :any, queryPath :string, prevChildName? :string) {
        this.broadcast(path, 'child_moved', ()=>val instanceof RDb3Snap ? val : new RDb3Snap(val, this, (queryPath || path)+'/'+child), prevChildName);
    }

    broadcastChildRemoved(path :string, child :string, val :any, queryPath :string) {
        this.broadcast(path, 'child_removed', ()=>val instanceof RDb3Snap ? val : new RDb3Snap(val, this, (queryPath || path)+'/'+child));
    }

    broadcast(path :string, type :string, snapProvider :()=>RDb3Snap, prevChildName? :string) {
        var sub = this.subscriptions[path];
        if (!sub) return;
        var handlers = sub.findByType(type);
        if (handlers.length == 0) return;
        var snap = snapProvider();
        for (var i = 0; i < handlers.length; i++) {
            handlers[i].callback(snap, prevChildName);
        }
    }

}

export class Subscription {

    constructor(public root :RDb3Root, public path :string) {

    }

    cbs: Handler[] = [];

    add(cb: Handler) {
        if (this.cbs.length == 0) this.subscribe();
        this.cbs.push(cb);
    }

    remove(cb: Handler) {
        this.cbs = this.cbs.filter((ocb) => ocb !== cb);
        if (this.cbs.length == 0) this.unsubscribe();
    }

    subscribe() {
        this.root.sendSubscribe(this.path);
    }

    unsubscribe() {
        this.root.unsubscribe(this.path);
    }

    findByType(evtype :string) :Handler[] {
        return this.cbs.filter((ocb)=>ocb.eventType==evtype);
    }

}

export abstract class Handler {
    public eventType: string;

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
        return this.tree.root.getValue(this.tree.url);
    }

    abstract init() :void;
}

class ValueCbHandler extends Handler {
    init() {
        this.eventType = 'value';
        var acval = this.getValue();
        if (acval !== null && typeof(acval) !== 'undefined') {
            this.callback(new RDb3Snap(this.getValue(), this.tree.root, this.tree.url));
        }
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

class ChildMovedCbHandler extends Handler {
    init() {
        this.eventType = 'child_moved';
        // This event never triggers on init
    }
}

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
    child_moved: ChildMovedCbHandler,
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

function findPreviousKey(obj :any, k :string) :string {
    var ks = getKeysOrdered(obj);
    var i = ks.indexOf(k);
    if (i<1) return null;
    return ks[i-1];
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
        return this.qsub || this.root.subscribe(this.url);
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
    
    private subQuery() {
        var ret = new RDb3Tree(this.root, this.url);
        ret.qsub = new QuerySubscription(this.getSubscription());
        return ret;
    }

    /**
    * Generates a new Query object ordered by the specified child key.
    */
    orderByChild(key: string): RDb3Tree {
        var ret = this.subQuery();
        ret.qsub.compareField = key;
        return ret;
    }
    /**
    * Generates a new Query object ordered by key name.
    */
    orderByKey(): RDb3Tree {
        var ret = this.subQuery();
        ret.qsub.compareField = null;
        return ret;
    }

    /**
    * Creates a Query with the specified starting point. 
    * The generated Query includes children which match the specified starting point.
    */
    startAt(value: string | number, key?: string): RDb3Tree {
        var ret = this.subQuery();
        ret.qsub.from = value;
        return ret;
    }

    /**
    * Creates a Query with the specified ending point. 
    * The generated Query includes children which match the specified ending point.
    */
    endAt(value: string | number, key?: string): RDb3Tree {
        var ret = this.subQuery();
        ret.qsub.to = value;
        return ret;
    }

    /**
    * Creates a Query which includes children which match the specified value.
    */
    equalTo(value: string | number, key?: string): RDb3Tree {
        var ret = this.subQuery();
        ret.qsub.equals = value;
        return ret;
    }
    /**
    * Generates a new Query object limited to the first certain number of children.
    */
    limitToFirst(limit: number): RDb3Tree {
        var ret = this.subQuery();
        ret.qsub.limit = limit;
        ret.qsub.limitLast = false;
        return ret;
    }
    /**
    * Generates a new Query object limited to the last certain number of children.
    */
    limitToLast(limit: number): RDb3Tree {
        var ret = this.subQuery();
        ret.qsub.limit = limit;
        ret.qsub.limitLast = true;
        return ret;
    }

    /**
    * Gets the absolute URL corresponding to this DbTree reference's location.
    */
    toString(): string {
        return this.root.makeAbsolute(this.url);
    }

    /**
    * Writes data to this DbTree location.
    */
    set(value: any, onComplete?: (error: any) => void): void {
        this.root.send('s', this.url, value, (ack:string)=>{
            if (onComplete) {
                if (ack == 'k') {
                    onComplete(null);
                } else {
                    onComplete(new Error(ack));
                }
            }
        });
        this.root.handleChange(this.url, value);
    }

    /**
    * Writes the enumerated children to this DbTree location.
    */
    update(value: any, onComplete?: (error: any) => void): void {
        this.root.send('m', this.url, value, (ack:string)=>{
            if (onComplete) {
                if (ack == 'k') {
                    onComplete(null);
                } else {
                    onComplete(new Error(ack));
                }
            }
        });
        for (var k in value) {
            this.root.handleChange(this.url + '/' + k, value[k]);
        }
    }

    /**
    * Removes the data at this DbTree location.
    */
    remove(onComplete?: (error: any) => void): void {
        this.set(null, onComplete);
    }

}


var progQId = 1;

export class QuerySubscription extends Subscription {
    id: string = (progQId++)+'a';

    compareField: string = null;
    from: string | number = null;
    to: string | number = null;
    equals: string | number;
    limit: number = null;
    limitLast = false;

    constructor(oth: Subscription | QuerySubscription) {
        super(oth.root, oth.path);
        if (oth instanceof QuerySubscription) {
            this.compareField = oth.compareField;
            this.from = oth.from;
            this.to = oth.to;
            this.equals = oth.equals;
            this.limit = oth.limit;
            this.limitLast = oth.limitLast;
        }
    }

    add(cb: Handler) {
        super.add(cb);
    }

    remove(cb: Handler) {
        super.remove(cb);
    }

    subscribe() {
        this.root.subscribeQuery(this);
        // TODO subscribe to this query
    }

    unsubscribe() {
        // TODO unsubscribe this query if handlers are zero
    }

    makeSorter() {
        if (!this.compareField) return null;
        return (a :any,b :any)=>{
            var va = a[this.compareField];
            var vb = b[this.compareField];
            if (va > vb) return 1;
            if (vb > va) return -1;
            return 0;
        };
    }
}
