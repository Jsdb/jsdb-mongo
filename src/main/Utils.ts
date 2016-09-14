export function normalizePath(path: string) {
    path = path.replace(/\/\.+\//g, '/');
    path = path.replace(/\/\/+/g, '/');
    if (path.charAt(0) != '/') path = '/' + path;
    if (path.charAt(path.length - 1) == '/') path = path.substr(0, path.length - 1);
    return path;
}

export function normalizeUpdatedValue(path: string, val: any): [string, any] {
    if (typeof (val) == 'function' || typeof (val) == 'object') return [path, val];
    var leaf = leafPath(path);
    var par = parentPath(path);
    var nval: any = {};
    nval[leaf] = val;
    return [par, nval];
}




export function leafPath(path: string): string {
    if (!path) return null;
    return path.substr(path.lastIndexOf('/') + 1);
}

export function parentPath(path: string): string {
    if (!path) return null;
    var ret = path.substr(0, path.lastIndexOf('/'));
    //if (ret.length == 0) return null;
    return ret;
}

/**
 * Given acpath = /a/b/c and parentpath = /a/ will return /a/b
 */
export function limitToChild(acpath: string, parentpath: string): string {
    if (acpath.indexOf(parentpath) != 0) return null;
    var sub = acpath.substr(parentpath.length);
    if (sub[0] == '/') sub = sub.substr(1);
    if (sub.indexOf('/') != -1) {
        sub = sub.substr(0, sub.indexOf('/'));
    }
    return parentpath + '/' + sub;
}

export function pathRegexp(path: string, subpath?: string): RegExp {
    path = path.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
    if (typeof (subpath) == 'string') {
        subpath = subpath.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
        return new RegExp('^' + path + '\/[^\/]+' + subpath + '$');
    } else {
        return new RegExp('^' + path + '.*');
    }
}

export function isEmpty(obj :any) :boolean {
    for (var k in obj) {
        return false;
    }
    return true;
}
