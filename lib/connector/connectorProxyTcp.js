"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
var tcpServer_1 = __importDefault(require("../components/tcpServer"));
var define = __importStar(require("../util/define"));
/**
 * connector  tcp
 */
var ConnectorTcp = /** @class */ (function () {
    function ConnectorTcp(info) {
        this.clientManager = null;
        this.heartbeatTime = 0; // 心跳时间
        this.maxConnectionNum = Number.POSITIVE_INFINITY;
        this.nowConnectionNum = 0;
        this.sendCache = false;
        this.interval = 0;
        this.app = info.app;
        this.clientManager = info.clientManager;
        var connectorConfig = info.config || {};
        var maxLen = connectorConfig.maxLen || define.some_config.SocketBufferMaxLen;
        var noDelay = connectorConfig.noDelay === false ? false : true;
        this.heartbeatTime = (connectorConfig.heartbeat || 0) * 1000;
        if (connectorConfig.maxConnectionNum != null) {
            this.maxConnectionNum = connectorConfig.maxConnectionNum;
        }
        var interval = Number(connectorConfig.interval) || 0;
        if (interval >= 10) {
            this.sendCache = true;
            this.interval = interval;
        }
        tcpServer_1.default(info.app.clientPort, maxLen, noDelay, info.startCb, this.newClientCb.bind(this));
        // 握手buffer
        var routeBuf = Buffer.from(JSON.stringify({ "route": this.app.routeConfig, "heartbeat": this.heartbeatTime / 1000 }));
        this.handshakeBuf = Buffer.alloc(routeBuf.length + 5);
        this.handshakeBuf.writeUInt32BE(routeBuf.length + 1, 0);
        this.handshakeBuf.writeUInt8(2 /* handshake */, 4);
        routeBuf.copy(this.handshakeBuf, 5);
        // 心跳回应buffer
        this.heartbeatBuf = Buffer.alloc(5);
        this.heartbeatBuf.writeUInt32BE(1, 0);
        this.heartbeatBuf.writeUInt8(3 /* heartbeatResponse */, 4);
    }
    ConnectorTcp.prototype.newClientCb = function (socket) {
        if (this.nowConnectionNum < this.maxConnectionNum) {
            new ClientSocket(this, this.clientManager, socket);
        }
        else {
            console.warn("socket num has reached the maxConnectionNum, close it");
            socket.close();
        }
    };
    return ConnectorTcp;
}());
exports.ConnectorTcp = ConnectorTcp;
var ClientSocket = /** @class */ (function () {
    function ClientSocket(connector, clientManager, socket) {
        var _this = this;
        this.session = null; // Session
        this.remoteAddress = "";
        this.handshakeOver = false; // 是否已经握手成功
        this.registerTimer = null; // 握手超时计时
        this.heartbeatTimer = null; // 心跳超时计时
        this.sendCache = false;
        this.interval = 0;
        this.sendTimer = null;
        this.sendArr = [];
        this.connector = connector;
        this.connector.nowConnectionNum++;
        this.sendCache = connector.sendCache;
        this.interval = connector.interval;
        this.clientManager = clientManager;
        this.socket = socket;
        this.remoteAddress = socket.remoteAddress;
        socket.on('data', this.onData.bind(this));
        socket.on('close', this.onClose.bind(this));
        this.registerTimer = setTimeout(function () {
            _this.close();
        }, 10000);
    }
    /**
     * 收到数据
     */
    ClientSocket.prototype.onData = function (data) {
        var type = data.readUInt8(0);
        if (type === 1 /* msg */) { // 普通的自定义消息
            this.clientManager.handleMsg(this, data);
        }
        else if (type === 3 /* heartbeat */) { // 心跳
            this.heartbeat();
            this.heartbeatResponse();
        }
        else if (type === 2 /* handshake */) { // 握手
            this.handshake();
        }
        else {
            this.close();
        }
    };
    /**
     * 关闭了
     */
    ClientSocket.prototype.onClose = function () {
        this.connector.nowConnectionNum--;
        clearTimeout(this.registerTimer);
        clearTimeout(this.heartbeatTimer);
        clearInterval(this.sendTimer);
        this.clientManager.removeClient(this);
    };
    /**
     * 握手
     */
    ClientSocket.prototype.handshake = function () {
        if (this.handshakeOver) {
            this.close();
            return;
        }
        this.handshakeOver = true;
        this.send(this.connector.handshakeBuf);
        clearTimeout(this.registerTimer);
        this.heartbeat();
        this.clientManager.addClient(this);
        if (this.sendCache) {
            this.sendTimer = setInterval(this.sendInterval.bind(this), this.interval);
        }
    };
    /**
     * 心跳
     */
    ClientSocket.prototype.heartbeat = function () {
        var _this = this;
        if (this.connector.heartbeatTime === 0) {
            return;
        }
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = setTimeout(function () {
            _this.close();
        }, this.connector.heartbeatTime * 2);
    };
    /**
     * 心跳回应
     */
    ClientSocket.prototype.heartbeatResponse = function () {
        this.send(this.connector.heartbeatBuf);
    };
    /**
     * 发送数据
     */
    ClientSocket.prototype.send = function (msg) {
        if (this.sendCache) {
            this.sendArr.push(msg);
        }
        else {
            this.socket.send(msg);
        }
    };
    ClientSocket.prototype.sendInterval = function () {
        if (this.sendArr.length > 0) {
            var arr = this.sendArr;
            for (var i = 0, len = arr.length; i < len; i++) {
                this.socket.send(arr[i]);
            }
            this.sendArr = [];
        }
    };
    /**
     * 关闭
     */
    ClientSocket.prototype.close = function () {
        this.socket.close();
    };
    return ClientSocket;
}());
