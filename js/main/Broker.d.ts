import * as Mongo from 'mongodb';
export interface AuthService {
    authenticate(socket: SocketIO.Socket): Promise<Object>;
}
export declare class Broker {
    private id;
    private socket;
    private collectionDb;
    private oplogDb;
    private collection;
    private oplog;
    private auth;
    private collectionNs;
    private started;
    private closed;
    private startWait;
    private handlers;
    private subscriptions;
    private lastOplogStream;
    constructor($socket?: SocketIO.Server, collectionDb?: string, collectionName?: string, oplogDb?: string, collectionOptions?: any);
    setSocket(value: SocketIO.Server): this;
    setCollection(value: Mongo.Collection): this;
    setOplogDb(value: Mongo.Db): this;
    initCollection(collectionDb: string, collectionName: string, collectionOptions?: Mongo.MongoClientOptions): this;
    initOplog(oplogDb: string): this;
    setAuthService(value: AuthService): this;
    start(): Promise<any>;
    private hookOplog();
    register(handler: Handler): void;
    unregister(handler: Handler): void;
    subscribe(handler: Handler, path: string): void;
    unsubscribe(handler: Handler, path: string): void;
    broadcast(path: string, val: any): void;
    private broadcastDown(path, val, alreadySent);
    private broadcastUp(path, val, fullpath, alreadySent);
    private broadcastToHandlers(path, val, alreadySent, fullpath?);
    close(): Promise<any>;
    static normalizePath(path: string): string;
    static leafPath(path: string): string;
    static parentPath(path: string): string;
    static pathRegexp(path: string): RegExp;
    del(handler: Handler, paths: string[]): Promise<any>;
    set(handler: Handler, path: string, val: any): Promise<any>;
    recursiveUnroll(path: string, val: any, writes?: any[], dels?: string[]): void;
    fetch(handler: Handler, path: string): void;
    stream(handler: Handler, path: string, data: any[]): void;
}
export declare class Handler {
    private socket;
    private authData;
    private broker;
    id: string;
    closed: boolean;
    private pathSubs;
    constructor(socket: SocketIO.Socket, authData: Object, broker: Broker);
    close(): void;
    subscribePath(path: string): string;
    unsubscribePath(path: string): string;
    ping(id: string): string;
    set(path: string, val: any, cb: Function): void;
    sendValue(path: string, val: any): void;
}
export declare class Recomposer {
    base: string;
    refs: {
        [index: string]: any;
    };
    constructor(base: string);
    add(obj: any): void;
    get(): any;
    private findOrCreateRefFor(path, obj);
}
