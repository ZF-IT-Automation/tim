"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHostedSyncServer = exports.createHostedSyncServer = exports.pullBlobs = exports.pushBlobs = exports.listFiles = exports.createFile = exports.TenantRegistry = exports.quotaExceeded = exports.getQuotaLimits = exports.TIER_QUOTAS = void 0;
var quotas_js_1 = require("./quotas.js");
Object.defineProperty(exports, "TIER_QUOTAS", { enumerable: true, get: function () { return quotas_js_1.TIER_QUOTAS; } });
Object.defineProperty(exports, "getQuotaLimits", { enumerable: true, get: function () { return quotas_js_1.getQuotaLimits; } });
Object.defineProperty(exports, "quotaExceeded", { enumerable: true, get: function () { return quotas_js_1.quotaExceeded; } });
var tenant_registry_js_1 = require("./tenant-registry.js");
Object.defineProperty(exports, "TenantRegistry", { enumerable: true, get: function () { return tenant_registry_js_1.TenantRegistry; } });
var storage_js_1 = require("./storage.js");
Object.defineProperty(exports, "createFile", { enumerable: true, get: function () { return storage_js_1.createFile; } });
Object.defineProperty(exports, "listFiles", { enumerable: true, get: function () { return storage_js_1.listFiles; } });
Object.defineProperty(exports, "pushBlobs", { enumerable: true, get: function () { return storage_js_1.pushBlobs; } });
Object.defineProperty(exports, "pullBlobs", { enumerable: true, get: function () { return storage_js_1.pullBlobs; } });
var server_js_1 = require("./server.js");
Object.defineProperty(exports, "createHostedSyncServer", { enumerable: true, get: function () { return server_js_1.createHostedSyncServer; } });
Object.defineProperty(exports, "startHostedSyncServer", { enumerable: true, get: function () { return server_js_1.startHostedSyncServer; } });
//# sourceMappingURL=index.js.map