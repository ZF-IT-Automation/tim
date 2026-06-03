"use strict";
// TIM Core Types — v0.1.0-alpha
// These types define the contract that all modules must implement.
Object.defineProperty(exports, "__esModule", { value: true });
exports.timSessionCachePath = exports.resolveActiveSessionId = exports.readTimSessionCache = exports.hooksEnabled = exports.normalizeHookScripts = exports.getTimDir = exports.getConfigPath = exports.saveConfig = exports.loadConfig = exports.InProcessEventBus = void 0;
var event_bus_js_1 = require("./event-bus.js");
Object.defineProperty(exports, "InProcessEventBus", { enumerable: true, get: function () { return event_bus_js_1.InProcessEventBus; } });
var config_js_1 = require("./config.js");
Object.defineProperty(exports, "loadConfig", { enumerable: true, get: function () { return config_js_1.loadConfig; } });
Object.defineProperty(exports, "saveConfig", { enumerable: true, get: function () { return config_js_1.saveConfig; } });
Object.defineProperty(exports, "getConfigPath", { enumerable: true, get: function () { return config_js_1.getConfigPath; } });
Object.defineProperty(exports, "getTimDir", { enumerable: true, get: function () { return config_js_1.getTimDir; } });
Object.defineProperty(exports, "normalizeHookScripts", { enumerable: true, get: function () { return config_js_1.normalizeHookScripts; } });
Object.defineProperty(exports, "hooksEnabled", { enumerable: true, get: function () { return config_js_1.hooksEnabled; } });
var session_cache_js_1 = require("./session-cache.js");
Object.defineProperty(exports, "readTimSessionCache", { enumerable: true, get: function () { return session_cache_js_1.readTimSessionCache; } });
Object.defineProperty(exports, "resolveActiveSessionId", { enumerable: true, get: function () { return session_cache_js_1.resolveActiveSessionId; } });
Object.defineProperty(exports, "timSessionCachePath", { enumerable: true, get: function () { return session_cache_js_1.timSessionCachePath; } });
//# sourceMappingURL=index.js.map