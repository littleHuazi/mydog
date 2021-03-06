"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
var define = require("../util/define");
var path = __importStar(require("path"));
var fs = __importStar(require("fs"));
var session_1 = require("./session");
var protocol = __importStar(require("../connector/protocol"));
var appUtil_1 = require("../util/appUtil");
var FrontendServer = /** @class */ (function () {
    function FrontendServer(app) {
        this.app = app;
    }
    /**
     * 启动
     */
    FrontendServer.prototype.start = function (cb) {
        session_1.initSessionApp(this.app);
        var self = this;
        var startCb = function () {
            var str = appUtil_1.concatStr("listening at [", self.app.host, ":", self.app.clientPort, "]  ", self.app.serverId, " (clientPort)");
            console.log(str);
            self.app.logger("info" /* info */, str);
            cb && cb();
        };
        protocol.init(this.app);
        var mydog = require("../mydog");
        var connectorConfig = this.app.someconfig.connector || {};
        var connectorConstructor = connectorConfig.connector || mydog.connector.connectorTcp;
        var defaultEncodeDecode;
        if (connectorConstructor === mydog.connector.connectorTcp) {
            defaultEncodeDecode = protocol.Tcp_EncodeDecode;
        }
        else if (connectorConstructor === mydog.connector.connectorWs) {
            defaultEncodeDecode = protocol.Ws_EncodeDecode;
        }
        else {
            defaultEncodeDecode = protocol.Tcp_EncodeDecode;
        }
        var encodeDecodeConfig = this.app.someconfig.encodeDecode || {};
        this.app.protoEncode = encodeDecodeConfig.protoEncode || defaultEncodeDecode.protoEncode;
        this.app.msgEncode = encodeDecodeConfig.msgEncode || defaultEncodeDecode.msgEncode;
        this.app.protoDecode = encodeDecodeConfig.protoDecode || defaultEncodeDecode.protoDecode;
        this.app.msgDecode = encodeDecodeConfig.msgDecode || defaultEncodeDecode.msgDecode;
        new connectorConstructor({
            "app": this.app,
            "clientManager": new ClientManager(this.app),
            "config": this.app.someconfig.connector,
            "startCb": startCb
        });
    };
    /**
     * 同步session
     */
    FrontendServer.prototype.applySession = function (data) {
        var session = JSON.parse(data.slice(1).toString());
        var client = this.app.clients[session.uid];
        if (client) {
            client.session.setAll(session);
        }
    };
    /**
     * 前端服将后端服的消息转发给客户端
     */
    FrontendServer.prototype.sendMsgByUids = function (data) {
        var uidBuffLen = data.readUInt16BE(1);
        var uids = JSON.parse(data.slice(3, 3 + uidBuffLen).toString());
        var msgBuf = data.slice(3 + uidBuffLen);
        var clients = this.app.clients;
        var client;
        for (var i = 0; i < uids.length; i++) {
            client = clients[uids[i]];
            if (client) {
                client.send(msgBuf);
            }
        }
    };
    return FrontendServer;
}());
exports.FrontendServer = FrontendServer;
var ClientManager = /** @class */ (function () {
    function ClientManager(app) {
        this.msgHandler = {};
        this.serverType = "";
        this.app = app;
        this.serverType = app.serverType;
        this.router = this.app.router;
        this.loadHandler();
    }
    /**
     * 前端服务器加载路由处理
     */
    ClientManager.prototype.loadHandler = function () {
        var dirName = path.join(this.app.base, define.some_config.File_Dir.Servers, this.serverType, "handler");
        var exists = fs.existsSync(dirName);
        if (exists) {
            var self_1 = this;
            fs.readdirSync(dirName).forEach(function (filename) {
                if (!/\.js$/.test(filename)) {
                    return;
                }
                var name = path.basename(filename, '.js');
                var handler = require(path.join(dirName, filename));
                if (handler.default && typeof handler.default === "function") {
                    self_1.msgHandler[name] = new handler.default(self_1.app);
                }
            });
        }
    };
    ClientManager.prototype.addClient = function (client) {
        if (!!client.session) {
            this.app.logger("error" /* error */, appUtil_1.concatStr("the I_client has already been added, close it"));
            client.close();
            return;
        }
        this.app.clientNum++;
        var session = new session_1.Session(this.app.serverId);
        session.socket = client;
        client.session = session;
    };
    ClientManager.prototype.removeClient = function (client) {
        if (!client.session) {
            return;
        }
        delete this.app.clients[client.session.uid];
        this.app.clientNum--;
        if (client.session._onclosed) {
            client.session._onclosed(this.app, client.session);
        }
        client.session = null;
    };
    ClientManager.prototype.handleMsg = function (client, msgBuf) {
        try {
            if (!client.session) {
                this.app.logger("error" /* error */, appUtil_1.concatStr("cannot handle msg before registered, close it, ", client.remoteAddress));
                client.close();
                return;
            }
            var data = this.app.protoDecode(msgBuf);
            var cmd = this.app.routeConfig[data.cmdId];
            if (!cmd) {
                this.app.logger("warn" /* warn */, appUtil_1.concatStr("route index out of range, ", data.cmdId, ", ", client.remoteAddress));
                return;
            }
            var cmdArr = cmd.split('.');
            if (this.serverType === cmdArr[0]) {
                var msg = this.app.msgDecode(data.cmdId, data.msg);
                this.msgHandler[cmdArr[1]][cmdArr[2]](msg, client.session, this.callBack(client, data.cmdId));
            }
            else {
                this.doRemote(data.cmdId, data.msg, client.session, cmdArr[0]);
            }
        }
        catch (e) {
            this.app.logger("warn" /* warn */, appUtil_1.concatStr("handleMsg err,", client.remoteAddress, "\n", e.stack));
        }
    };
    /**
     * 回调
     */
    ClientManager.prototype.callBack = function (client, cmdId) {
        var self = this;
        return function (msg) {
            if (msg === undefined) {
                msg = null;
            }
            var buf = self.app.protoEncode(cmdId, msg);
            client.send(buf);
        };
    };
    /**
     * 转发客户端消息到后端服务器
     */
    ClientManager.prototype.doRemote = function (cmdId, msgBuf, session, serverType) {
        var _this = this;
        var tmpRouter = this.router[serverType] || this.defaultRoute;
        tmpRouter(this.app, session, serverType, function (id) {
            if (!_this.app.rpcPool.hasSocket(id)) {
                _this.app.logger("warn" /* warn */, appUtil_1.concatStr("has no backend server named ", id + ", ", session.socket.remoteAddress));
                return;
            }
            if (_this.app.serversIdMap[id].frontend) {
                _this.app.logger("warn" /* warn */, appUtil_1.concatStr("cannot send msg to frontendServer ", id, ", ", session.socket.remoteAddress));
                return;
            }
            var sessionBuf = session.sessionBuf;
            var buf = Buffer.allocUnsafe(9 + sessionBuf.length + msgBuf.length);
            buf.writeUInt32BE(5 + sessionBuf.length + msgBuf.length, 0);
            buf.writeUInt8(4 /* clientMsgIn */, 4);
            buf.writeUInt16BE(sessionBuf.length, 5);
            sessionBuf.copy(buf, 7);
            buf.writeUInt16BE(cmdId, 7 + sessionBuf.length);
            msgBuf.copy(buf, 9 + sessionBuf.length);
            _this.app.rpcPool.sendMsg(id, buf);
        });
    };
    ClientManager.prototype.defaultRoute = function (app, session, serverType, cb) {
        var list = app.getServersByType(serverType);
        if (list.length === 0) {
            cb("");
            return;
        }
        var index = Math.floor(Math.random() * list.length);
        cb(list[index].id);
    };
    return ClientManager;
}());
