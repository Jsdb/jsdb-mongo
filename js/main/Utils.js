(function (factory) {
    if (typeof module === 'object' && typeof module.exports === 'object') {
        var v = factory(require, exports); if (v !== undefined) module.exports = v;
    }
    else if (typeof define === 'function' && define.amd) {
        define(["require", "exports"], factory);
    }
})(function (require, exports) {
    "use strict";
    function normalizePath(path) {
        path = path.replace(/\/\.+\//g, '/');
        path = path.replace(/\/\/+/g, '/');
        if (path.charAt(0) != '/')
            path = '/' + path;
        if (path.charAt(path.length - 1) == '/')
            path = path.substr(0, path.length - 1);
        return path;
    }
    exports.normalizePath = normalizePath;
    function normalizeUpdatedValue(path, val) {
        if (typeof (val) == 'function' || typeof (val) == 'object')
            return [path, val];
        var leaf = leafPath(path);
        var par = parentPath(path);
        var nval = {};
        nval[leaf] = val;
        return [par, nval];
    }
    exports.normalizeUpdatedValue = normalizeUpdatedValue;
    function leafPath(path) {
        if (!path)
            return null;
        return path.substr(path.lastIndexOf('/') + 1);
    }
    exports.leafPath = leafPath;
    function parentPath(path) {
        if (!path)
            return null;
        var ret = path.substr(0, path.lastIndexOf('/'));
        //if (ret.length == 0) return null;
        return ret;
    }
    exports.parentPath = parentPath;
    /**
     * Given acpath = /a/b/c and parentpath = /a/ will return /a/b
     */
    function limitToChild(acpath, parentpath) {
        if (acpath.indexOf(parentpath) != 0)
            return null;
        var sub = acpath.substr(parentpath.length);
        if (sub[0] == '/')
            sub = sub.substr(1);
        if (sub.indexOf('/') != -1) {
            sub = sub.substr(0, sub.indexOf('/'));
        }
        return parentpath + '/' + sub;
    }
    exports.limitToChild = limitToChild;
    function pathRegexp(path, subpath) {
        path = path.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
        if (typeof (subpath) == 'string') {
            subpath = subpath.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
            if (subpath.charAt(0) != '/')
                subpath = '/' + subpath;
            return new RegExp('^' + path + '\/[^\/]+' + subpath + '$');
        }
        else {
            return new RegExp('^' + path + '.*');
        }
    }
    exports.pathRegexp = pathRegexp;
    function isEmpty(obj) {
        for (var k in obj) {
            return false;
        }
        return true;
    }
    exports.isEmpty = isEmpty;
});

//# sourceMappingURL=Utils.js.map
