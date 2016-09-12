

import {Broker, VERSION} from './Broker';
import * as SocketIO from 'socket.io';

var usage = "\
jsdbmongo \
  -h host host\
  -d dbname\
  -c collection-name\
  -r replicaset\
  -u user\
  -p password\
  -ou oplog-user\
  -op oplog-password\
  -P port\
  OR\
  -curl collection-mongourl\
  -ourl oplog-mongourl\
";

console.log("JSDB-MONGO " + VERSION);

var args :any = {};
var lastArg = '_';
for (var i = 2; i < process.argv.length; i++) {
    var arg = process.argv[i];
    if (arg.charAt(0) == '-') {
        lastArg = arg.substr(1);
    } else {
        var type = typeof(args[lastArg]);
        if (type === 'array') {
            args[lastArg].push(arg);
        } else if (type === 'undefined') {
            args[lastArg] = arg;
        } else {
            args[lastArg] = [args[lastArg]];
            args[lastArg].push(arg);
        }
    }
}

function makeUrl(user? :string, pass? :string) {
    var url = 'mongodb://';
    if (user || args['u']) {
        url += (user || args['u']);
        if (pass || args['p']) {
            url += ':';
            url += (pass || args['p']);
        }
        url += '@';
    }
    if (typeof(args['h']) == 'array') {
        for (var i = 0; i < args['h'].length; i++) {
            url += args['h'][i] + ',';
        }
        url = url.slice(0,-1);
    } else {
        url += args['h'];
    }
    url += '/';
    return url;
}

if (!args['curl']) {
    args['curl'] = makeUrl() + args['d'] + (args['r'] ? "?replicaSet=" + args['r'] : '');
}

if (!args['ourl']) {
    args['ourl'] = makeUrl(args['ou'], args['op']) + "local?" + (args['r'] ? "replicaSet=" + args['r'] : '') + "&authSource=admin";
}

var io = SocketIO();
io.on('connection', function(socket){});
var port = parseInt(args['P']||3000);
io.listen(port);


var brk = new Broker(io, args['curl'], args['c'], args['ourl']);
brk.start()

console.log("Connecting to " + args['curl'] + " " + args['ourl']);

console.log("Started on port " + port);




