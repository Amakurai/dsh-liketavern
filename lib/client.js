window.__ModuleLoader__.load({
  id: "dsh-liketavern",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lib/client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// node_modules/zod/v4/core/core.js
var _a;
// @__NO_SIDE_EFFECTS__
function $constructor(name2, initializer2, params) {
  function init(inst, def) {
    if (!inst._zod) {
      Object.defineProperty(inst, "_zod", {
        value: {
          def,
          constr: _,
          traits: /* @__PURE__ */ new Set()
        },
        enumerable: false
      });
    }
    if (inst._zod.traits.has(name2)) {
      return;
    }
    inst._zod.traits.add(name2);
    initializer2(inst, def);
    const proto = _.prototype;
    const keys = Object.keys(proto);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name2 });
  function _(def) {
    var _a2;
    const inst = params?.Parent ? new Definition() : this;
    init(inst, def);
    (_a2 = inst._zod).deferred ?? (_a2.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name2);
    }
  });
  Object.defineProperty(_, "name", { value: name2 });
  return _;
}
var $brand = Symbol("zod_brand");
var $ZodAsyncError = class extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
};
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}

// node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
function nullish(input) {
  return input === null || input === void 0;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
var EVALUATING = /* @__PURE__ */ Symbol("evaluating");
function defineLazy(object2, key, getter) {
  let value = void 0;
  Object.defineProperty(object2, key, {
    get() {
      if (value === EVALUATING) {
        return void 0;
      }
      if (value === void 0) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object2, key, {
        value: v
        // configurable: true,
      });
    },
    configurable: true
  });
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {
};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== void 0) {
    if (params?.error !== void 0)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-34028234663852886e22, 34028234663852886e22],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a2;
    (_a2 = iss).path ?? (_a2.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config2) {
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
  const { inst: _inst, continue: _continue, input: _input, ...rest } = iss;
  rest.path ?? (rest.path = []);
  rest.message = message;
  if (ctx?.reportInput) {
    rest.input = _input;
  }
  return rest;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}

// node_modules/zod/v4/core/errors.js
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: () => inst.message,
    enumerable: false
  });
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, { Parent: Error });

// node_modules/zod/v4/core/parse.js
var _parse = (_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
};
var parse = /* @__PURE__ */ _parse($ZodRealError);
var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
};
var parseAsync = /* @__PURE__ */ _parseAsync($ZodRealError);
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);

// node_modules/zod/v4/core/regexes.js
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
var date = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
var string = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;

// node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a2;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a2 = inst._zod).onattach ?? (_a2.onattach = []);
});
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});

// node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 4,
  patch: 3
};

// node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a2;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [...inst._zod.def.checks ?? []];
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a2 = inst._zod).deferred ?? (_a2.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks2, ctx) => {
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks2) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError();
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary2) => {
            return handleCanaryResult(canary2, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return result.then((result2) => runChecks(result2, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  defineLazy(inst, "~standard", () => ({
    validate: (value) => {
      try {
        const r = safeParse(inst, value);
        return r.success ? { value: r.data } : { issues: r.error?.issues };
      } catch (_) {
        return safeParseAsync(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  }));
});
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_2) {
      }
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input, isOptionalIn, isOptionalOut) {
  const isPresent = key in input;
  if (result.issues.length) {
    if (isOptionalIn && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && !isOptionalIn) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: void 0,
        path: [key]
      });
    }
    return;
  }
  if (result.value === void 0) {
    if (isPresent) {
      final.value[key] = void 0;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t2 = _catchall.def.type;
  const isOptionalIn = _catchall.optin === "optional";
  const isOptionalOut = _catchall.optout === "optional";
  for (const key in input) {
    if (key === "__proto__")
      continue;
    if (keySet.has(key))
      continue;
    if (t2 === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, isOptionalIn, isOptionalOut)));
    } else {
      handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  if (!desc?.get) {
    const sh = def.shape;
    Object.defineProperty(def, "shape", {
      get: () => {
        const newSh = { ...sh };
        Object.defineProperty(def, "shape", {
          value: newSh
        });
        return newSh;
      }
    });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
        for (const v of field.values)
          propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const isOptionalIn = el._zod.optin === "optional";
      const isOptionalOut = el._zod.optout === "optional";
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, isOptionalIn, isOptionalOut)));
      } else {
        handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return void 0;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  const values = new Set(def.values);
  inst._zod.values = values;
  inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (input === void 0 && (result.issues.length || result.fallback)) {
    return { issues: [], value: void 0 };
  }
  return result;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const input = payload.value;
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((r) => handleOptionalResult(r, input));
      return handleOptionalResult(result, input);
    }
    if (payload.value === void 0) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});

// node_modules/zod/v4/core/api.js
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
  return new Class({
    type: "string",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
  return new Class({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
  return new Class({
    type: "unknown"
  });
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}

// node_modules/zod/v4/mini/schemas.js
var ZodMiniType = /* @__PURE__ */ $constructor("ZodMiniType", (inst, def) => {
  if (!inst._zod)
    throw new Error("Uninitialized schema in ZodMiniType.");
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
  inst.safeParse = (data, params) => safeParse(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
  inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
  inst.check = (...checks) => {
    return inst.clone({
      ...def,
      checks: [
        ...def.checks ?? [],
        ...checks.map((ch) => typeof ch === "function" ? {
          _zod: { check: ch, def: { check: "custom" }, onattach: [] }
        } : ch)
      ]
    }, { parent: true });
  };
  inst.with = inst.check;
  inst.clone = (_def, params) => clone(inst, _def, params);
  inst.brand = () => inst;
  inst.register = ((reg, meta2) => {
    reg.add(inst, meta2);
    return inst;
  });
  inst.apply = (fn) => fn(inst);
});
var ZodMiniString = /* @__PURE__ */ $constructor("ZodMiniString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function string2(params) {
  return _string(ZodMiniString, params);
}
var ZodMiniNumber = /* @__PURE__ */ $constructor("ZodMiniNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function number2(params) {
  return _number(ZodMiniNumber, params);
}
var ZodMiniNumberFormat = /* @__PURE__ */ $constructor("ZodMiniNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodMiniNumber.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function int(params) {
  return _int(ZodMiniNumberFormat, params);
}
var ZodMiniBoolean = /* @__PURE__ */ $constructor("ZodMiniBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function boolean2(params) {
  return _boolean(ZodMiniBoolean, params);
}
var ZodMiniUnknown = /* @__PURE__ */ $constructor("ZodMiniUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function unknown() {
  return _unknown(ZodMiniUnknown);
}
var ZodMiniArray = /* @__PURE__ */ $constructor("ZodMiniArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function array(element, params) {
  return new ZodMiniArray({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
var ZodMiniObject = /* @__PURE__ */ $constructor("ZodMiniObject", (inst, def) => {
  $ZodObject.init(inst, def);
  ZodMiniType.init(inst, def);
  defineLazy(inst, "shape", () => def.shape);
});
// @__NO_SIDE_EFFECTS__
function object(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...normalizeParams(params)
  };
  return new ZodMiniObject(def);
}
var ZodMiniUnion = /* @__PURE__ */ $constructor("ZodMiniUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function union(options, params) {
  return new ZodMiniUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodMiniEnum = /* @__PURE__ */ $constructor("ZodMiniEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodMiniType.init(inst, def);
  inst.options = Object.values(def.entries);
});
// @__NO_SIDE_EFFECTS__
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodMiniEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
var ZodMiniLiteral = /* @__PURE__ */ $constructor("ZodMiniLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function literal(value, params) {
  return new ZodMiniLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
var ZodMiniOptional = /* @__PURE__ */ $constructor("ZodMiniOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function optional(innerType) {
  return new ZodMiniOptional({
    type: "optional",
    innerType
  });
}
var ZodMiniNullable = /* @__PURE__ */ $constructor("ZodMiniNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function nullable(innerType) {
  return new ZodMiniNullable({
    type: "nullable",
    innerType
  });
}

// lib/remote.js
var nonEmpty = () => string2().check(_minLength(1));
var turnNumber = () => int().check(_gte(1));
var sessionBinding = () => object({
  sessionId: nonEmpty(),
  cardId: nonEmpty(),
  cardName: optional(string2()),
  storyId: optional(nonEmpty()),
  presetId: nullable(string2()),
  personaId: nullable(string2()),
  lorebookIds: array(string2()),
  characterLorebookId: nullable(string2()),
  interactiveCards: nullable(boolean2()),
  greetingIndex: int().check(_gte(0)),
  authorNote: optional(string2()),
  injectJournal: optional(boolean2()),
  walLineage: optional(array(object({ sessionId: nonEmpty(), throughTurn: int().check(_gte(0)) }))),
  createdAt: nonEmpty()
});
var persona = () => object({
  id: nonEmpty(),
  name: string2(),
  description: string2(),
  avatar: nullable(string2()),
  lorebookId: optional(nullable(string2()))
});
var regexRule = () => object({
  id: nonEmpty(),
  name: string2(),
  find: string2(),
  replace: string2(),
  enabled: boolean2(),
  scopes: array(_enum(["input", "output", "prompt"])),
  timing: array(_enum(["assemble", "send", "render"])),
  minDepth: nullable(number2()),
  maxDepth: nullable(number2()),
  substituteRegex: union([literal(0), literal(1), literal(2)]),
  source: _enum(["user", "card", "preset"]),
  roles: optional(array(_enum(["system", "user", "assistant"]))),
  trimStrings: optional(array(string2())),
  trimStringsRegex: optional(array(string2()))
});
var anyValue = unknown();
var sessionIdField = { sessionId: nonEmpty() };
var cardIdField = { cardId: nonEmpty() };
var storyScope = { ...cardIdField, storyId: optional(nonEmpty()) };
var messageIdField = { messageId: nonEmpty() };
var METHODS = {
  listStories: { req: object(cardIdField), value: anyValue, summary: "\u5217\u51FA\u89D2\u8272\u7684\u72EC\u7ACB\u5267\u60C5\u72B6\u6001" },
  // 角色
  listCharacters: { req: object({}), value: anyValue, summary: "\u5217\u51FA\u5168\u90E8\u89D2\u8272\u5361" },
  inspectCharacter: {
    // dataBase64：卡文件字节（PNG/JSON），传输层只判非空；V1/V2/V3 结构由 state/card 的 normalizeCard 归一化校验。
    req: object({ name: nonEmpty(), dataBase64: nonEmpty() }),
    value: anyValue,
    summary: "\u89E3\u6790\u89D2\u8272\u5361\u4F46\u4E0D\u843D\u76D8\uFF08\u5BFC\u5165\u524D\u9884\u89C8\u5185\u5D4C\u4E16\u754C\u4E66\uFF09"
  },
  importCharacter: {
    // dataBase64：同 inspectCharacter，卡结构由 state/card 归一化校验。
    req: object({
      name: nonEmpty(),
      dataBase64: nonEmpty(),
      importWorldBook: optional(boolean2())
    }),
    value: anyValue,
    summary: "\u5BFC\u5165\u89D2\u8272\u5361\uFF08PNG/JSON\uFF0Cbase64\uFF09"
  },
  deleteCharacter: { req: object({ ...cardIdField }), value: anyValue, summary: "\u5220\u9664\u89D2\u8272\u5361\u5DE5\u4F5C\u533A" },
  getCharacterDetail: { req: object({ ...cardIdField }), value: anyValue, summary: "\u89D2\u8272\u5361\u8BE6\u60C5\uFF08\u5F52\u4E00\u5316\u5361 + \u5F00\u573A\u767D\u5217\u8868\uFF09" },
  saveCharacter: {
    req: object({
      ...cardIdField,
      name: optional(string2()),
      description: optional(string2()),
      personality: optional(string2()),
      scenario: optional(string2()),
      firstMes: optional(string2()),
      alternateGreetings: optional(array(string2())),
      mesExample: optional(string2()),
      systemPrompt: optional(string2()),
      postHistoryInstructions: optional(string2()),
      creatorNotes: optional(string2()),
      creator: optional(string2()),
      characterVersion: optional(string2()),
      tags: optional(array(string2())),
      depthPrompt: optional(nullable(object({
        prompt: string2(),
        depth: number2(),
        role: _enum(["system", "user", "assistant"])
      })))
    }),
    value: anyValue,
    summary: "\u4FDD\u5B58\u89D2\u8272\u5361\u6B63\u6587\uFF08\u4E0D\u6539 cardId\uFF09"
  },
  createCharacter: { req: object({ name: nonEmpty() }), value: anyValue, summary: "\u65B0\u5EFA\u7A7A\u767D\u89D2\u8272\u5361" },
  exportCharacter: { req: object({ ...cardIdField }), value: anyValue, summary: "\u5BFC\u51FA\u89D2\u8272\u5361 JSON \u4E0E PNG" },
  // 预设
  listPresets: { req: object({}), value: anyValue, summary: "\u5217\u51FA\u63D0\u793A\u8BCD\u9884\u8BBE" },
  importPreset: {
    // json：ST 预设 JSON，字段随 ST 版本演进，宽松传输，由 state/presetStore 归一化时严格校验。
    req: object({ name: nonEmpty(), json: anyValue }),
    value: anyValue,
    summary: "\u5BFC\u5165 SillyTavern \u9884\u8BBE JSON"
  },
  // preset：同上，宽松传输，state/presetStore 归一化时严格校验。
  savePreset: { req: object({ preset: anyValue }), value: anyValue, summary: "\u4FDD\u5B58\u9884\u8BBE" },
  deletePreset: { req: object({ id: nonEmpty() }), value: anyValue, summary: "\u5220\u9664\u9884\u8BBE" },
  getPreset: { req: object({ id: nonEmpty() }), value: anyValue, summary: "\u8BFB\u53D6\u9884\u8BBE" },
  // 世界书库
  listLorebooks: { req: object({}), value: anyValue, summary: "\u5217\u51FA\u4E16\u754C\u4E66" },
  getLorebook: { req: object({ name: nonEmpty() }), value: anyValue, summary: "\u8BFB\u53D6\u4E16\u754C\u4E66\u539F\u59CB JSON" },
  // json：世界书原始 JSON（ST 导出形态多样），宽松传输，由 state/lorebook 归一化时严格校验。
  importLorebook: { req: object({ name: nonEmpty(), json: anyValue }), value: anyValue, summary: "\u5BFC\u5165\u4E16\u754C\u4E66 JSON" },
  saveLorebook: { req: object({ name: nonEmpty(), json: anyValue }), value: anyValue, summary: "\u4FDD\u5B58\u4E16\u754C\u4E66 JSON" },
  deleteLorebook: { req: object({ name: nonEmpty() }), value: anyValue, summary: "\u5220\u9664\u4E16\u754C\u4E66" },
  getCharacterLorebook: { req: object({ ...cardIdField }), value: anyValue, summary: "\u8BFB\u53D6\u89D2\u8272\u5361\u5185\u5D4C\u4E16\u754C\u4E66" },
  saveCharacterLorebook: {
    // json：卡内嵌世界书，宽松传输，state/card 的 normalizeBook 归一化时严格校验。
    req: object({ ...cardIdField, json: anyValue }),
    value: anyValue,
    summary: "\u4FDD\u5B58\u89D2\u8272\u5361\u5185\u5D4C\u4E16\u754C\u4E66"
  },
  deleteEmbeddedLorebook: { req: object({ ...cardIdField }), value: anyValue, summary: "\u5220\u9664\u89D2\u8272\u5361\u5185\u5D4C\u4E16\u754C\u4E66\uFF08\u4FDD\u7559\u89D2\u8272\u5361\uFF09" },
  getChatLorebook: { req: object({ ...storyScope }), value: anyValue, summary: "\u8BFB\u53D6\u4F1A\u8BDD\u4E16\u754C\u4E66" },
  // json：会话世界书，宽松传输，state/lorebook 归一化时严格校验。
  saveChatLorebook: { req: object({ ...storyScope, json: anyValue }), value: anyValue, summary: "\u4FDD\u5B58\u4F1A\u8BDD\u4E16\u754C\u4E66" },
  getJournal: { req: object({ ...storyScope }), value: anyValue, summary: "\u8BFB\u53D6\u89D2\u8272\u7B14\u8BB0 journal.md" },
  saveJournal: { req: object({ ...storyScope, text: string2() }), value: anyValue, summary: "\u4FDD\u5B58\u89D2\u8272\u7B14\u8BB0 journal.md" },
  // 人设
  listPersonas: { req: object({}), value: anyValue, summary: "\u5217\u51FA\u4EBA\u8BBE" },
  savePersona: { req: object({ persona: persona() }), value: anyValue, summary: "\u4FDD\u5B58\u4EBA\u8BBE" },
  deletePersona: { req: object({ id: nonEmpty() }), value: anyValue, summary: "\u5220\u9664\u4EBA\u8BBE" },
  // 正则
  listRegexRules: { req: object({}), value: anyValue, summary: "\u5217\u51FA\u5168\u5C40\u6B63\u5219\u89C4\u5219" },
  saveRegexRules: { req: object({ rules: array(regexRule()) }), value: anyValue, summary: "\u4FDD\u5B58\u5168\u5C40\u6B63\u5219\u89C4\u5219" },
  // 会话绑定
  getSessionBinding: { req: object({ ...sessionIdField }), value: anyValue, summary: "\u8BFB\u53D6\u4F1A\u8BDD\u7ED1\u5B9A" },
  setSessionBinding: { req: object({ binding: sessionBinding() }), value: anyValue, summary: "\u4FDD\u5B58\u4F1A\u8BDD\u7ED1\u5B9A" },
  clearSessionBinding: { req: object({ ...sessionIdField }), value: anyValue, summary: "\u6E05\u9664\u4F1A\u8BDD\u89D2\u8272\u5361\u7ED1\u5B9A" },
  // 开场白
  ensureGreeting: { req: object({ ...sessionIdField }), value: anyValue, summary: "\u786E\u4FDD\u4F1A\u8BDD\u6709\u5F00\u573A\u767D" },
  getGreetingSwipe: {
    req: object({ ...sessionIdField, ...messageIdField }),
    value: anyValue,
    summary: "\u5F00\u573A\u767D\u697C\u5C42\u7684 swipe \u4E0B\u6807\uFF08\u975E\u5F00\u573A\u767D\u8FD4\u56DE null\uFF09"
  },
  renderOutputText: {
    req: object({ ...sessionIdField, text: string2() }),
    value: anyValue,
    summary: "\u5BF9\u5C55\u793A\u6587\u672C\u5E94\u7528 output/render \u6B63\u5219\u5E76\u62BD\u51FA HTML"
  },
  swipeGreeting: {
    req: object({ ...sessionIdField, index: int().check(_gte(0)) }),
    value: anyValue,
    summary: "\u5207\u6362\u5F00\u573A\u767D\u53D8\u4F53\uFF08\u4EA7\u751F\u5B50\u4F1A\u8BDD\uFF09"
  },
  // 楼层（按 assistant 消息 id 定位楼层；被中断的楼层没有 finalized 消息、宿主 slot 不挂，
  // 操作条由 chat.node 渲染侧补挂并以 turn 定位，故 regenerate/rollbackToFloor/getFloorSiblings
  // 额外接受 turn 号；操作产生分支子会话，client 负责打开）
  regenerate: {
    req: object({ ...sessionIdField, messageId: optional(nonEmpty()), turn: optional(turnNumber()) }),
    value: anyValue,
    summary: "\u91CD\u65B0\u751F\u6210\u6307\u5B9A\u697C\u5C42\uFF08\u7F3A\u7701\u6700\u540E\u4E00\u8F6E\uFF09\uFF0C\u5206\u652F\u4F1A\u8BDD\u81EA\u52A8\u7EED\u8DD1"
  },
  rollbackToFloor: {
    req: object({ ...sessionIdField, messageId: optional(nonEmpty()), turn: optional(turnNumber()) }),
    value: anyValue,
    summary: "\u56DE\u9000\u5230\u6307\u5B9A\u697C\u5C42\uFF08\u4FDD\u7559\u8BE5\u5C42\uFF0C\u4E22\u5F03\u5176\u540E\uFF09\uFF0C\u4E0D\u81EA\u52A8\u7EED\u8DD1\uFF1BmessageId \u4E0E turn \u81F3\u5C11\u7ED9\u5176\u4E00"
  },
  getFloorUserMessage: {
    req: object({ ...sessionIdField, ...messageIdField }),
    value: anyValue,
    summary: "\u8BFB\u53D6\u6307\u5B9A\u697C\u5C42\u7684\u9996\u6761\u7528\u6237\u6D88\u606F\uFF08\u7F16\u8F91\u9884\u586B\u7528\uFF09"
  },
  editUserMessage: {
    req: object({ ...sessionIdField, ...messageIdField, text: nonEmpty() }),
    value: anyValue,
    summary: "\u7F16\u8F91\u6307\u5B9A\u697C\u5C42\u7684\u7528\u6237\u6D88\u606F\u5E76\u91CD\u8DD1\uFF08\u4EA7\u751F\u5B50\u4F1A\u8BDD\uFF09"
  },
  getFloorAssistantMessage: {
    req: object({ ...sessionIdField, ...messageIdField }),
    value: anyValue,
    summary: "\u8BFB\u53D6\u6307\u5B9A\u697C\u5C42\u7684 assistant \u6B63\u6587\uFF08\u7F16\u8F91\u9884\u586B\u7528\uFF09"
  },
  editAssistantMessage: {
    req: object({ ...sessionIdField, ...messageIdField, text: nonEmpty() }),
    value: anyValue,
    summary: "\u7F16\u8F91\u6307\u5B9A\u697C\u5C42\u7684 assistant \u6B63\u6587\uFF08\u4EA7\u751F\u5B50\u4F1A\u8BDD\uFF0C\u505C\u5728\u7F16\u8F91\u540E\u72B6\u6001\uFF09"
  },
  continueFloor: {
    req: object({ ...sessionIdField, ...messageIdField }),
    value: anyValue,
    summary: "\u7EED\u5199\u6700\u540E\u4E00\u5C42\uFF08\u88AB\u622A\u65AD\u7684\uFF09\u56DE\u590D\uFF1A\u4E0D fork\uFF0C\u76F4\u63A5\u9A71\u52A8\u753B\u524D\u4F1A\u8BDD"
  },
  getFloorSiblings: {
    req: object({ ...sessionIdField, messageId: optional(nonEmpty()), turn: optional(turnNumber()) }),
    value: object({
      swipe: nullable(object({
        turn: int(),
        index: int(),
        total: int(),
        siblings: array(string2())
      }))
    }),
    summary: "\u540C\u4E00\u697C\u5C42\u5206\u652F\u4F1A\u8BDD\u7684\u5144\u5F1F\u5BFC\u822A\uFF08\u2039 n/m \u203A\uFF1B\u65E0\u5144\u5F1F\u65F6 swipe=null\uFF09"
  },
  impersonate: {
    req: object({ ...sessionIdField }),
    value: anyValue,
    summary: "\u4EE5\u7528\u6237\u8EAB\u4EFD\u4EE3\u5199\u4E00\u53E5\u53F0\u8BCD\uFF08\u4E0D\u5165\u4F1A\u8BDD\u65E5\u5FD7\uFF0C\u7531\u524D\u7AEF\u586B\u5165\u8F93\u5165\uFF09"
  },
  // 记忆
  getMemories: { req: object({ ...storyScope }), value: anyValue, summary: "\u5217\u51FA\u89D2\u8272\u8BB0\u5FC6" },
  saveMemory: {
    req: object({
      ...storyScope,
      id: optional(nonEmpty()),
      body: nonEmpty(),
      tags: optional(array(string2())),
      keys: optional(array(string2()))
    }),
    value: anyValue,
    summary: "\u65B0\u589E\u6216\u66F4\u65B0\u8BB0\u5FC6"
  },
  deleteMemory: { req: object({ ...storyScope, id: nonEmpty() }), value: anyValue, summary: "\u5220\u9664\u8BB0\u5FC6" },
  compressMemories: { req: object({ ...storyScope }), value: anyValue, summary: "\u65E0\u635F\u5F52\u5E76\u6700\u65E7\u4E00\u6279\u8BB0\u5FC6\uFF08\u51CF\u5C11\u6761\u76EE\u6570\uFF09" },
  // 世界状态
  getWorldDeltas: { req: object({ ...storyScope }), value: anyValue, summary: "\u5217\u51FA\u4E16\u754C\u72B6\u6001\u53D8\u5316\u5C42" },
  revokeWorldDelta: { req: object({ ...storyScope, id: nonEmpty() }), value: anyValue, summary: "\u64A4\u9500\u4E00\u6761\u53D8\u5316" },
  addWorldDelta: {
    req: object({
      ...storyScope,
      type: _enum(["add", "update", "invalidate"]),
      content: nonEmpty(),
      ref: optional(nullable(string2())),
      keys: optional(array(string2())),
      order: optional(number2())
    }),
    value: anyValue,
    summary: "\u624B\u52A8\u65B0\u589E\u4E00\u6761\u4E16\u754C\u72B6\u6001"
  },
  exportMergedLorebook: { req: object({ ...storyScope }), value: anyValue, summary: "\u5BFC\u51FA\u5408\u5E76\u53D8\u5316\u5C42\u540E\u7684\u4E16\u754C\u4E66" },
  // 调试
  getTriggerLog: { req: object({ ...sessionIdField }), value: anyValue, summary: "\u6700\u8FD1\u4E00\u6B21\u7EC4\u88C5\u7684\u89E6\u53D1\u65E5\u5FD7" },
  previewPrompt: { req: object({ ...sessionIdField }), value: anyValue, summary: "\u9884\u89C8\u5B8C\u6574\u63D0\u793A\u8BCD\u5E8F\u5217" },
  getContextUsage: {
    req: object({ ...sessionIdField }),
    value: anyValue,
    summary: "\u8BFB\u53D6\u4F1A\u8BDD\u4E0A\u4E0B\u6587\u5360\u7528\uFF08token-meter \u6295\u5F71\uFF1B\u5BBF\u4E3B\u672A\u6302\u6295\u5F71\u65F6 usage=null\uFF09"
  },
  getDataInfo: { req: object({}), value: anyValue, summary: "Tavern \u6570\u636E\u76EE\u5F55\u8DEF\u5F84" },
  getAvatar: { req: object({ ...cardIdField }), value: anyValue, summary: "\u89D2\u8272\u5934\u50CF dataURL" },
  // 设置（采样参数与世界书全局设置等，落 dsh 设置命名空间 dsh-tavern）
  getSettings: { req: object({}), value: anyValue, summary: "\u8BFB\u53D6 Tavern \u8BBE\u7F6E" },
  // patch：设置深补丁（嵌套 Partial，难用 zod 精确刻画），宽松传输，由 schemastery（node/config）校验合并。
  updateSettings: { req: object({ patch: anyValue }), value: anyValue, summary: "\u5408\u5E76\u66F4\u65B0 Tavern \u8BBE\u7F6E" }
};
function descriptor(method, def) {
  return {
    id: `dsh-liketavern#tavern/${method}`,
    service: "tavern",
    namespace: "tavern",
    method,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: { mode: "strict", typeSymbol: `dsh-liketavern/types#${method}Request`, schema: def.req }
      }
    ],
    result: { mode: "strict", typeSymbol: `dsh-liketavern/types#${method}Result`, schema: def.value }
  };
}
var descriptors = Object.entries(METHODS).map(([method, def]) => descriptor(method, def));
var TYPERT_HOST = {
  package: "dsh-liketavern",
  face: "host",
  schemas: [],
  invocations: descriptors,
  model: {
    services: [
      {
        description: "Tavern \u89D2\u8272\u626E\u6F14\u670D\u52A1\uFF1A\u89D2\u8272\u5361\u3001\u4E16\u754C\u4E66\u3001\u9884\u8BBE\u3001\u8BB0\u5FC6\u3001\u4E16\u754C\u72B6\u6001\u3001\u697C\u5C42\u64CD\u4F5C\u4E0E\u63D0\u793A\u8BCD\u9884\u89C8\u3002",
        summary: "SillyTavern \u517C\u5BB9\u89D2\u8272\u626E\u6F14\u670D\u52A1\u3002",
        tags: [],
        jsDoc: "/** Tavern service: cards, lorebooks, presets, memories, world deltas, floor ops. */",
        key: "tavern",
        exportName: "TavernService",
        members: Object.entries(METHODS).map(([method, def]) => ({
          kind: "method",
          name: method,
          signature: `async ${method}(request): Promise<Envelope>`,
          summary: def.summary,
          jsDoc: `/** ${def.summary} */`
        })),
        types: []
      }
    ],
    events: [],
    objects: []
  }
};
var TYPERT_REMOTE = {
  package: "dsh-liketavern",
  descriptors
};

// lib/client/actions.js
var import_jsx_runtime2 = require("react/jsx-runtime");
var import_react3 = require("react");
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");

// lib/client/cache.js
var META_TTL_MS = 3e4;
var AVATAR_TTL_MS = 6e4;
function read(map, key, ttlMs, load) {
  const hit = map.get(key);
  if (hit?.pending)
    return hit.pending;
  if (hit?.value && Date.now() - hit.at < ttlMs)
    return Promise.resolve(hit.value);
  const pending = load().then((r) => {
    if (r.ok) {
      if (map.get(key)?.pending !== pending)
        return r;
      const now = Date.now();
      for (const [k, entry] of map) {
        if (!entry.pending && entry.value && now - entry.at >= ttlMs)
          map.delete(k);
      }
      map.set(key, { at: now, value: r });
    } else if (map.get(key)?.pending === pending) {
      map.delete(key);
    }
    return r;
  }, (err) => {
    if (map.get(key)?.pending === pending)
      map.delete(key);
    throw err;
  });
  map.set(key, { at: Date.now(), pending });
  return pending;
}
var bindings = /* @__PURE__ */ new Map();
var details = /* @__PURE__ */ new Map();
var avatars = /* @__PURE__ */ new Map();
function cachedSessionBinding(remote, sessionId) {
  return read(bindings, sessionId, META_TTL_MS, () => remote.getSessionBinding({ sessionId }));
}
function cachedCharacterDetail(remote, cardId) {
  return read(details, cardId, META_TTL_MS, () => remote.getCharacterDetail({ cardId }));
}
function cachedAvatar(remote, cardId) {
  return read(avatars, cardId, AVATAR_TTL_MS, () => remote.getAvatar({ cardId }));
}
function invalidateSessionBinding(sessionId) {
  bindings.delete(sessionId);
}
function invalidateCharacter(cardId) {
  details.delete(cardId);
  avatars.delete(cardId);
}

// lib/client/i18n.js
var import_react = require("react");

// lib/client/locales/actions.js
var zh = {
  "actions.branchPrev": "\u4E0A\u4E00\u4E2A\u5206\u652F\uFF08\u540C\u4E00\u697C\u5C42\u7684\u53E6\u4E00\u7248\u56DE\u590D\uFF09",
  "actions.branchNext": "\u4E0B\u4E00\u4E2A\u5206\u652F\uFF08\u540C\u4E00\u697C\u5C42\u7684\u53E6\u4E00\u7248\u56DE\u590D\uFF09",
  "actions.branchCount": "\u7B2C {turn} \u5C42\u6709 {total} \u4E2A\u5206\u652F",
  "actions.branchGone": "\u8FD9\u4E2A\u5206\u652F\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664",
  "actions.swipePrev": "\u4E0A\u4E00\u6761\u5F00\u573A\u767D",
  "actions.swipeNext": "\u4E0B\u4E00\u6761\u5F00\u573A\u767D",
  "actions.regenerate": "\u91CD\u65B0\u751F\u6210\u8FD9\u4E00\u5C42",
  "actions.continue": "\u7EED\u5199\u8FD9\u4E00\u5C42\uFF08\u63A5\u7740\u88AB\u622A\u65AD\u7684\u56DE\u590D\u5199\uFF09",
  "actions.editUser": "\u7F16\u8F91\u8FD9\u4E00\u5C42\u7684\u7528\u6237\u6D88\u606F",
  "actions.editAi": "\u7F16\u8F91\u56DE\u590D\u5E76\u64A4\u9500\u8BE5\u5C42\u65E7\u4E8B\u5B9E\uFF08\u4E0D\u91CD\u8DD1\uFF09",
  "actions.impersonate": "AI \u4EE3\u7B54\u7528\u6237\uFF08\u751F\u6210\u6211\u7684\u53F0\u8BCD\uFF0C\u590D\u5236\u5230\u526A\u8D34\u677F\uFF09",
  "actions.impersonateCopied": "\u7528\u6237\u53F0\u8BCD\u5DF2\u751F\u6210\u5E76\u590D\u5236\u5230\u526A\u8D34\u677F\uFF0C\u7C98\u8D34\u5230\u8F93\u5165\u6846\u540E\u53D1\u9001",
  "actions.impersonateTitle": "AI \u4EE3\u7B54\u7684\u7528\u6237\u53F0\u8BCD",
  "actions.clipboardUnavailable": "\u526A\u8D34\u677F\u4E0D\u53EF\u7528\uFF0C\u8BF7\u624B\u52A8\u590D\u5236\u540E\u7C98\u8D34\u5230\u8F93\u5165\u6846\u3002",
  "actions.rollback": "\u56DE\u9000\u5230\u8FD9\u4E00\u5C42\uFF08\u4E22\u5F03\u5176\u540E\u697C\u5C42\uFF09",
  "actions.editUserTitle": "\u7F16\u8F91\u7B2C {turn} \u5C42\u7684\u7528\u6237\u6D88\u606F",
  "actions.editAiTitle": "\u7F16\u8F91\u7B2C {turn} \u5C42\u7684\u56DE\u590D",
  "actions.saving": "\u4FDD\u5B58\u4E2D\u2026",
  "actions.saveRerun": "\u4FDD\u5B58\u5E76\u91CD\u8DD1",
  "actions.saveNoRerun": "\u4FDD\u5B58\uFF08\u4E0D\u91CD\u8DD1\uFF09"
};
var en = {
  "actions.branchPrev": "Previous branch (another reply on this floor)",
  "actions.branchNext": "Next branch (another reply on this floor)",
  "actions.branchCount": "Floor {turn} has {total} branches",
  "actions.branchGone": "This branch session no longer exists or has been deleted",
  "actions.swipePrev": "Previous greeting",
  "actions.swipeNext": "Next greeting",
  "actions.regenerate": "Regenerate this floor",
  "actions.continue": "Continue this floor (pick up a truncated reply)",
  "actions.editUser": "Edit the user message on this floor",
  "actions.editAi": "Edit reply and revoke its old facts (no rerun)",
  "actions.impersonate": "AI impersonation (generate my line, copied to clipboard)",
  "actions.impersonateCopied": "User line generated and copied to clipboard \u2014 paste it into the input box to send",
  "actions.impersonateTitle": "AI-impersonated user line",
  "actions.clipboardUnavailable": "Clipboard unavailable. Copy the text manually and paste it into the input box.",
  "actions.rollback": "Roll back to this floor (discard later floors)",
  "actions.editUserTitle": "Edit user message on floor {turn}",
  "actions.editAiTitle": "Edit reply on floor {turn}",
  "actions.saving": "Saving\u2026",
  "actions.saveRerun": "Save & rerun",
  "actions.saveNoRerun": "Save (no rerun)"
};

// lib/client/locales/assistant.js
var zh2 = {
  "assistant.truncated": "\u5185\u5BB9\u5DF2\u622A\u65AD\uFF08\u5171 {total} \u5B57\u7B26\uFF09",
  "assistant.thinking": "\u601D\u8003\u4E2D\u2026",
  "assistant.thought": "\u601D\u8003\u8FC7\u7A0B",
  "assistant.characterFallback": "\u89D2\u8272",
  "assistant.stopped": "\u5DF2\u505C\u6B62",
  "assistant.unknownBlock": "\u672A\u77E5\u5757"
};
var en2 = {
  "assistant.truncated": "Content truncated ({total} characters total)",
  "assistant.thinking": "Thinking\u2026",
  "assistant.thought": "Reasoning",
  "assistant.characterFallback": "Character",
  "assistant.stopped": "Stopped",
  "assistant.unknownBlock": "Unknown block"
};

// lib/client/locales/characters.js
var zh3 = {
  "characters.section.desc": "\u5BFC\u5165\u6216\u65B0\u5EFA\u89D2\u8272\u5361\u3002\u70B9\u8FDB\u5361\u7247\u53EF\u7F16\u8F91\u6B63\u6587\u5E76\u5BFC\u51FA PNG/JSON\u3002\u5220\u9664\u4F1A\u6E05\u6389\u8BE5\u5361\u5DE5\u4F5C\u533A\uFF0C\u4EE5\u53CA\u4ECD\u6307\u5411\u5B83\u7684\u4F1A\u8BDD\u7ED1\u5B9A\u3002",
  "characters.what": "\u89D2\u8272\u5361",
  "characters.importFile": "\u5BFC\u5165 PNG / JSON",
  "characters.newCard": "\u65B0\u5EFA\u7A7A\u767D\u5361",
  "characters.searchLabel": "\u641C\u7D22\u89D2\u8272\u5361",
  "characters.searchPlaceholder": "\u641C\u7D22\u89D2\u8272\u540D / \u5185\u5D4C\u4E66\u540D",
  "characters.emptyDesc": "\u5BFC\u5165\u4E00\u5F20 SillyTavern \u89D2\u8272\u5361\uFF0C\u6216\u65B0\u5EFA\u7A7A\u767D\u5361\u3002",
  "characters.imported": "\u5DF2\u5BFC\u5165\u89D2\u8272\u5361",
  "characters.importedWithBook": "\u5DF2\u5BFC\u5165\u89D2\u8272\u5361\uFF08\u542B\u5185\u5D4C\u4E16\u754C\u4E66\uFF09",
  "characters.deleted": "\u5DF2\u5220\u9664\u300C{name}\u300D",
  "characters.deletedSalvaged": "\u5DF2\u5220\u9664\u300C{name}\u300D\uFF0C\u5185\u5D4C\u4E16\u754C\u4E66\u5DF2\u4FDD\u7559\u5230\u4E16\u754C\u4E66\u5E93\uFF1A{book}",
  "characters.created": "\u5DF2\u521B\u5EFA\u300C{name}\u300D",
  "characters.card.delete": "\u5220\u9664\u89D2\u8272\u5361",
  "characters.card.embeddedBook": "\u5185\u5D4C\u4E16\u754C\u4E66",
  "characters.card.embeddedBookNamed": "\u5185\u5D4C\u4E16\u754C\u4E66\u300C{name}\u300D",
  "characters.card.entryCount": "{count} \u6761",
  "characters.detail.title": "\u7F16\u8F91\u89D2\u8272\uFF1A{name}",
  "characters.detail.nameRequired": "\u89D2\u8272\u540D\u4E0D\u80FD\u4E3A\u7A7A",
  "characters.detail.saved": "\u5DF2\u4FDD\u5B58\u300C{name}\u300D",
  "characters.detail.exported": "\u5DF2\u5BFC\u51FA {kind}",
  "characters.detail.displayName": "\u663E\u793A\u540D\uFF08\u4E0D\u4F1A\u6539\u5DE5\u4F5C\u533A ID\uFF09",
  "characters.detail.unknownCreator": "\u672A\u77E5\u4F5C\u8005",
  "characters.detail.groupPersona": "\u4EBA\u8BBE\u4E0E\u573A\u666F",
  "characters.detail.description": "\u63CF\u8FF0",
  "characters.detail.personality": "\u6027\u683C",
  "characters.detail.scenario": "\u573A\u666F",
  "characters.detail.groupGreetings": "\u5F00\u573A\u767D\u4E0E\u793A\u4F8B",
  "characters.detail.greeting": "\u5F00\u573A\u767D",
  "characters.detail.altGreetings": "\u5F00\u573A\u767D\u53D8\u4F53\uFF08\u6BCF\u884C\u4E00\u6761\uFF09",
  "characters.detail.mesExample": "\u5BF9\u8BDD\u793A\u4F8B",
  "characters.detail.groupAdvanced": "\u9AD8\u7EA7\u6CE8\u5165",
  "characters.detail.systemPrompt": "\u7CFB\u7EDF\u63D0\u793A",
  "characters.detail.postHistory": "\u5386\u53F2\u540E\u6307\u4EE4",
  "characters.detail.depthPrompt": "depth_prompt\uFF08\u6A21\u62DF\u6309\u6DF1\u5EA6\u63D2\u4F4D\uFF1Blive \u9759\u6001\u8FDB standing\uFF0C\u52A8\u6001\u8FDB turn\uFF09",
  "characters.detail.depth": "\u6DF1\u5EA6",
  "characters.detail.role": "\u89D2\u8272",
  "characters.detail.groupMetadata": "\u5143\u6570\u636E",
  "characters.detail.creatorNotes": "\u4F5C\u8005\u5907\u6CE8",
  "characters.detail.creator": "\u4F5C\u8005",
  "characters.detail.version": "\u7248\u672C",
  "characters.detail.tags": "\u6807\u7B7E\uFF08\u9017\u53F7\u5206\u9694\uFF09",
  "characters.detail.exportPng": "\u5BFC\u51FA PNG",
  "characters.detail.exportJson": "\u5BFC\u51FA JSON",
  "characters.detail.interactiveTitle": "\u4EA4\u4E92\u5361\uFF1A{name}",
  "characters.detail.interactiveFrame": "\u4EA4\u4E92\u5361",
  "characters.importBook.title": "\u5BFC\u5165\u5185\u5D4C\u4E16\u754C\u4E66\uFF1F",
  "characters.importBook.desc": "\u89D2\u8272\u5361\u300C{name}\u300D\u5185\u5D4C\u4E16\u754C\u4E66\uFF0C\u5171 {count} \u6761\u3002\u5BFC\u5165\u540E\u4F1A\u4F5C\u4E3A\u8BE5\u5361\u7684\u4E3B\u4E16\u754C\u4E66\u3002",
  "characters.importBook.descNamed": "\u89D2\u8272\u5361\u300C{name}\u300D\u5185\u5D4C\u4E16\u754C\u4E66\u300C{book}\u300D\uFF0C\u5171 {count} \u6761\u3002\u5BFC\u5165\u540E\u4F1A\u4F5C\u4E3A\u8BE5\u5361\u7684\u4E3B\u4E16\u754C\u4E66\u3002",
  "characters.importBook.skip": "\u8DF3\u8FC7",
  "characters.importBook.import": "\u5BFC\u5165\u4E16\u754C\u4E66",
  "characters.importBook.skipNote": "\u8DF3\u8FC7\u540E\u4ECD\u5BFC\u5165\u89D2\u8272\u5361\uFF08\u63CF\u8FF0\u3001\u5F00\u573A\u767D\u3001\u6B63\u5219\uFF09\uFF0C\u53EA\u662F\u4E0D\u542F\u7528\u8FD9\u672C\u5185\u5D4C\u4E16\u754C\u4E66\u3002",
  "characters.delete.title": "\u5220\u9664\u89D2\u8272\u5361\uFF1F",
  "characters.delete.desc": "\u786E\u5B9A\u5220\u9664\u89D2\u8272\u300C{name}\u300D\uFF1F\u5176\u5DE5\u4F5C\u533A\uFF08\u8BB0\u5FC6/\u4E16\u754C\u72B6\u6001\uFF09\u4EE5\u53CA\u4ECD\u7ED1\u5B9A\u8BE5\u5361\u7684\u4F1A\u8BDD\u90FD\u4F1A\u89E3\u9664\u3002\u6587\u4EF6\u5939 ID \u4E0D\u4F1A\u51FA\u73B0\u5728\u5BF9\u8BDD\u6807\u9898\u91CC\u3002",
  "characters.create.title": "\u65B0\u5EFA\u7A7A\u767D\u89D2\u8272\u5361",
  "characters.create.desc": "\u5148\u5EFA\u4E00\u5F20\u53EA\u6709\u540D\u5B57\u548C\u9ED8\u8BA4\u5F00\u573A\u767D\u7684\u5361\uFF0C\u518D\u70B9\u8FDB\u53BB\u586B\u63CF\u8FF0\u3002",
  "characters.create.confirm": "\u521B\u5EFA",
  "characters.create.namePlaceholder": "\u89D2\u8272\u540D"
};
var en3 = {
  "characters.section.desc": "Import or create character cards. Open a card to edit its content and export PNG/JSON. Deleting a card wipes its workspace and unbinds any sessions still pointing to it.",
  "characters.what": "character cards",
  "characters.importFile": "Import PNG / JSON",
  "characters.newCard": "New blank card",
  "characters.searchLabel": "Search character cards",
  "characters.searchPlaceholder": "Search character / embedded book name",
  "characters.emptyDesc": "Import a SillyTavern character card, or create a blank one.",
  "characters.imported": "Character card imported",
  "characters.importedWithBook": "Character card imported (embedded lorebook included)",
  "characters.deleted": "Deleted \u201C{name}\u201D",
  "characters.deletedSalvaged": "Deleted \u201C{name}\u201D; embedded lorebook kept in the library: {book}",
  "characters.created": "Created \u201C{name}\u201D",
  "characters.card.delete": "Delete character card",
  "characters.card.embeddedBook": "Embedded lorebook",
  "characters.card.embeddedBookNamed": "Embedded lorebook \u201C{name}\u201D",
  "characters.card.entryCount": "{count} entries",
  "characters.detail.title": "Edit character: {name}",
  "characters.detail.nameRequired": "Character name is required",
  "characters.detail.saved": "Saved \u201C{name}\u201D",
  "characters.detail.exported": "Exported {kind}",
  "characters.detail.displayName": "Display name (does not change the workspace ID)",
  "characters.detail.unknownCreator": "Unknown creator",
  "characters.detail.groupPersona": "Persona & Scenario",
  "characters.detail.description": "Description",
  "characters.detail.personality": "Personality",
  "characters.detail.scenario": "Scenario",
  "characters.detail.groupGreetings": "Greetings & Examples",
  "characters.detail.greeting": "Greeting",
  "characters.detail.altGreetings": "Alternate greetings (one per line)",
  "characters.detail.mesExample": "Message examples",
  "characters.detail.groupAdvanced": "Advanced Injection",
  "characters.detail.systemPrompt": "System prompt",
  "characters.detail.postHistory": "Post-history instructions",
  "characters.detail.depthPrompt": "depth_prompt (depth in simulation; static standing or dynamic turn in live chats)",
  "characters.detail.depth": "Depth",
  "characters.detail.role": "Role",
  "characters.detail.groupMetadata": "Metadata",
  "characters.detail.creatorNotes": "Creator notes",
  "characters.detail.creator": "Creator",
  "characters.detail.version": "Version",
  "characters.detail.tags": "Tags (comma-separated)",
  "characters.detail.exportPng": "Export PNG",
  "characters.detail.exportJson": "Export JSON",
  "characters.detail.interactiveTitle": "Interactive card: {name}",
  "characters.detail.interactiveFrame": "Interactive card",
  "characters.importBook.title": "Import embedded lorebook?",
  "characters.importBook.desc": "The character card \u201C{name}\u201D contains an embedded lorebook with {count} entries. It will serve as the card\u2019s primary lorebook after import.",
  "characters.importBook.descNamed": "The character card \u201C{name}\u201D contains the embedded lorebook \u201C{book}\u201D with {count} entries. It will serve as the card\u2019s primary lorebook after import.",
  "characters.importBook.skip": "Skip",
  "characters.importBook.import": "Import lorebook",
  "characters.importBook.skipNote": "Skipping still imports the character card (description, greetings, regex); the embedded lorebook just won\u2019t be enabled.",
  "characters.delete.title": "Delete character card?",
  "characters.delete.desc": "Delete character \u201C{name}\u201D? Its workspace (memory / world state) will be wiped and sessions still bound to it will be unbound. The folder ID never appears in conversation titles.",
  "characters.create.title": "New blank character card",
  "characters.create.desc": "Create a card with just a name and a default greeting first, then open it to fill in the details.",
  "characters.create.confirm": "Create",
  "characters.create.namePlaceholder": "Character name"
};

// lib/client/locales/chip.js
var zh4 = {
  "chip.preview.actual": "\u6700\u8FD1\u5BBF\u4E3B\u8BF7\u6C42",
  "chip.preview.noActual": "\u5C1A\u672A\u6355\u83B7\u8BF7\u6C42\u3002\u5148\u53D1\u9001\u4E00\u8F6E\u6D88\u606F\uFF1B\u91CD\u542F\u6216\u7F13\u5B58\u6DD8\u6C70\u540E\u65E7\u8BF7\u6C42\u4E0D\u53EF\u7528\u3002",
  "chip.preview.actualTruncated": "\uFF08\u8BF7\u6C42\u8D85\u8FC7\u663E\u793A\u4E0A\u9650\uFF0C\u5185\u5BB9\u5DF2\u622A\u65AD\uFF09",
  "chip.preview.notice": "\u6700\u8FD1\u8BF7\u6C42\u6765\u81EA\u5BBF\u4E3B llm/stream \u8FB9\u754C\uFF08\u9002\u914D\u5668\u8F6C\u6362\u524D\uFF09\u3002\u5176\u4ED6\u9875\u7B7E\u4E3A\u91CD\u65B0\u8BA1\u7B97\u7684 ST \u6A21\u62DF\uFF0C\u6DF1\u5EA6\u63D2\u5165\u3001\u5386\u53F2\u6B63\u5219\u4E0E\u88C1\u526A\u4E0D\u80FD\u4EE3\u8868\u5B9E\u9645\u8BF7\u6C42\u3002",
  "chip.characterFallback": "\u89D2\u8272",
  "chip.dialog.title": "Tavern \u7ED1\u5B9A",
  "chip.group.binding": "\u7ED1\u5B9A",
  "chip.group.turnInject": "\u672C\u8F6E\u6CE8\u5165",
  "chip.group.greetingDebug": "\u5F00\u573A\u767D\u4E0E\u8C03\u8BD5",
  "chip.field.character": "\u89D2\u8272",
  "chip.field.selectCharacter": "\uFF08\u9009\u62E9\u89D2\u8272\uFF09",
  "chip.field.preset": "\u9884\u8BBE",
  "chip.field.builtinPreset": "\uFF08\u5185\u5EFA\u9ED8\u8BA4\uFF09",
  "chip.field.persona": "\u4EBA\u8BBE",
  "chip.field.none": "\uFF08\u65E0\uFF09",
  "chip.field.mainLore": "\u4E3B\u4E16\u754C\u4E66",
  "chip.field.globalLore": "\u5168\u5C40\u4E16\u754C\u4E66\uFF08\u591A\u9009\uFF09",
  "chip.field.globalLoreAria": "\u5168\u5C40\u4E16\u754C\u4E66",
  "chip.field.noLorebooks": "\u5E93\u4E2D\u6682\u65E0\u4E16\u754C\u4E66",
  "chip.field.authorNote": "\u4F5C\u8005\u6CE8\u91CA\uFF08\u672C\u4F1A\u8BDD\uFF0C\u8FDB\u672C\u8F6E turn\uFF09",
  "chip.field.injectJournal": "\u6CE8\u5165\u89D2\u8272\u7B14\u8BB0 journal.md",
  "chip.embeddedBook.withCount": "{name}\uFF08\u5361\u5185\u5D4C {count} \u6761\uFF09",
  "chip.embeddedBook.noCount": "{name}\uFF08\u5361\u5185\u5D4C\uFF09",
  "chip.embeddedBook.none": "\uFF08\u5361\u5185\u5D4C\u4E66 / \u65E0\uFF09",
  "chip.saved": "\u7ED1\u5B9A\u5DF2\u4FDD\u5B58\uFF08\u5BF9\u4E4B\u540E\u7684\u6D88\u606F\u751F\u6548\uFF09",
  "chip.greeting.inserted": "\u5DF2\u63D2\u5165\u5F00\u573A\u767D",
  "chip.greeting.skipped": "\u4F1A\u8BDD\u5DF2\u6709\u5185\u5BB9\uFF0C\u672A\u63D2\u5165",
  "chip.greeting.prev": "\u4E0A\u4E00\u6761\u5F00\u573A\u767D",
  "chip.greeting.next": "\u4E0B\u4E00\u6761\u5F00\u573A\u767D",
  "chip.swipe.none": "\u8BE5\u89D2\u8272\u6CA1\u6709\u989D\u5916\u5F00\u573A\u767D",
  "chip.swipe.childCreated": "\u5206\u652F\u4F1A\u8BDD\u5DF2\u521B\u5EFA\uFF0C\u8BF7\u5728\u4F1A\u8BDD\u5217\u8868\u4E2D\u6253\u5F00",
  "chip.unbind.action": "\u89E3\u9664\u7ED1\u5B9A",
  "chip.unbind.title": "\u89E3\u9664\u89D2\u8272\u7ED1\u5B9A\uFF1F",
  "chip.unbind.desc": "\u89E3\u9664\u540E\u672C\u4F1A\u8BDD\u4E0D\u518D\u4F7F\u7528\u89D2\u8272\u5361\uFF0C\u540E\u7EED\u56DE\u590D\u6309\u666E\u901A Tavern \u52A9\u624B\u3002\u5BF9\u8BDD\u8BB0\u5F55\u4E0D\u4F1A\u5220\u9664\u3002",
  "chip.log.time": "\u65F6\u95F4\uFF1A{at}",
  "chip.log.empty": "\u6682\u65E0\u65E5\u5FD7\uFF08\u8BE5\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u8DD1\u8FC7\u4E00\u6B21 Tavern \u7EC4\u88C5\uFF09",
  "chip.chatLore.title": "\u672C\u4F1A\u8BDD\u4E16\u754C\u4E66",
  "chip.chatLore.edit": "\u7F16\u8F91\u672C\u4F1A\u8BDD\u4E16\u754C\u4E66",
  "chip.chatLore.saved": "\u5DF2\u4FDD\u5B58\u672C\u4F1A\u8BDD\u4E16\u754C\u4E66",
  "chip.usage.aria": "\u4E0A\u4E0B\u6587\u5360\u7528",
  "chip.usage.label": "\u4E0A\u4E0B\u6587\uFF1A",
  "chip.usage.full": "{used} / {window}\uFF08{percent}%\uFF09",
  "chip.usage.approx": "\u7EA6 {tokens} token",
  "chip.usage.breakdown": "\u7CFB\u7EDF {system} \xB7 \u5DE5\u5177 {tools} \xB7 \u6D88\u606F {messages}",
  "chip.preview.title": "\u63D0\u793A\u8BCD\u9884\u89C8",
  "chip.preview.empty": "\uFF08\u7A7A\uFF09",
  "chip.preview.noLog": "\uFF08\u65E0\u89E6\u53D1\u65E5\u5FD7\uFF09",
  "chip.preview.copied": "\u5DF2\u590D\u5236\u5F53\u524D\u89C6\u56FE\u5185\u5BB9",
  "chip.preview.copyFailed": "\u590D\u5236\u5931\u8D25",
  "chip.preview.copyView": "\u590D\u5236\u5F53\u524D\u89C6\u56FE",
  "chip.preview.budget": "\u4E16\u754C\u4E66\u9884\u7B97 {used}/{limit}",
  "chip.preview.overflowed": "\u5DF2\u6EA2\u51FA",
  "chip.preview.assemble": "\u7EC4\u88C5 {after}/{before} token",
  "chip.preview.trimmed": "\u88C1\u526A {sections}",
  "chip.preview.listSep": "\u3001",
  "chip.preview.tab.turn": "\u672C\u8F6E turn",
  "chip.preview.tab.full": "ST \u6A21\u62DF\u5E8F\u5217"
};
var en4 = {
  "chip.preview.actual": "Last host request",
  "chip.preview.noActual": "No request captured. Send a message first; snapshots are unavailable after restart or eviction.",
  "chip.preview.actualTruncated": "(Request exceeded the display limit and was truncated.)",
  "chip.preview.notice": "Last request is observed at llm/stream, before adapter conversion. Other tabs recalculate an ST simulation; depth injection, history regex and trimming do not describe the actual request.",
  "chip.characterFallback": "Character",
  "chip.dialog.title": "Tavern binding",
  "chip.group.binding": "Binding",
  "chip.group.turnInject": "This-turn injection",
  "chip.group.greetingDebug": "Greeting & debug",
  "chip.field.character": "Character",
  "chip.field.selectCharacter": "(select character)",
  "chip.field.preset": "Preset",
  "chip.field.builtinPreset": "(built-in default)",
  "chip.field.persona": "Persona",
  "chip.field.none": "(none)",
  "chip.field.mainLore": "Primary lorebook",
  "chip.field.globalLore": "Global lorebooks (multi-select)",
  "chip.field.globalLoreAria": "Global lorebooks",
  "chip.field.noLorebooks": "No lorebooks in the library",
  "chip.field.authorNote": "Author\u2019s note (this session, into this turn)",
  "chip.field.injectJournal": "Inject the character\u2019s journal.md",
  "chip.embeddedBook.withCount": "{name} (embedded, {count} entries)",
  "chip.embeddedBook.noCount": "{name} (embedded)",
  "chip.embeddedBook.none": "(embedded book / none)",
  "chip.saved": "Binding saved (applies to later messages)",
  "chip.greeting.inserted": "Greeting inserted",
  "chip.greeting.skipped": "Session already has content; not inserted",
  "chip.greeting.prev": "Previous greeting",
  "chip.greeting.next": "Next greeting",
  "chip.swipe.none": "This character has no alternate greetings",
  "chip.swipe.childCreated": "Fork session created; open it from the session list",
  "chip.unbind.action": "Unbind",
  "chip.unbind.title": "Unbind character?",
  "chip.unbind.desc": "After unbinding, this session no longer uses the character card and replies as a plain Tavern assistant. Chat history is not deleted.",
  "chip.log.time": "Time: {at}",
  "chip.log.empty": "No log yet (this session has not run a Tavern assembly)",
  "chip.chatLore.title": "Session lorebook",
  "chip.chatLore.edit": "Edit session lorebook",
  "chip.chatLore.saved": "Session lorebook saved",
  "chip.usage.aria": "Context usage",
  "chip.usage.label": "Context: ",
  "chip.usage.full": "{used} / {window} ({percent}%)",
  "chip.usage.approx": "~{tokens} tokens",
  "chip.usage.breakdown": "system {system} \xB7 tools {tools} \xB7 messages {messages}",
  "chip.preview.title": "Prompt preview",
  "chip.preview.empty": "(empty)",
  "chip.preview.noLog": "(no trigger log)",
  "chip.preview.copied": "Current view copied",
  "chip.preview.copyFailed": "Copy failed",
  "chip.preview.copyView": "Copy current view",
  "chip.preview.budget": "World info budget {used}/{limit}",
  "chip.preview.overflowed": "overflowed",
  "chip.preview.assemble": "assemble {after}/{before} tokens",
  "chip.preview.trimmed": "trimmed {sections}",
  "chip.preview.listSep": ", ",
  "chip.preview.tab.turn": "This turn",
  "chip.preview.tab.full": "ST simulation"
};

// lib/client/locales/common.js
var zh5 = {
  "settings.label": "Tavern",
  "section.characters": "\u89D2\u8272\u5361",
  "section.presets": "\u63D0\u793A\u8BCD\u9884\u8BBE",
  "section.lorebooks": "\u4E16\u754C\u4E66",
  "section.personas": "\u7528\u6237",
  "section.regex": "\u6B63\u5219\u811A\u672C",
  "section.memory": "\u8BB0\u5FC6\u4E0E\u4E16\u754C\u72B6\u6001",
  "section.sampling": "\u91C7\u6837\u53C2\u6570",
  "section.worldInfo": "\u4E16\u754C\u4E66\u5168\u5C40\u8BBE\u7F6E",
  "action.import": "\u5BFC\u5165",
  "action.delete": "\u5220\u9664",
  "action.detail": "\u8BE6\u60C5",
  "action.save": "\u4FDD\u5B58",
  "action.new": "\u65B0\u5EFA",
  "action.edit": "\u7F16\u8F91",
  "action.refresh": "\u5237\u65B0",
  "action.regenerate": "\u91CD\u65B0\u751F\u6210",
  "action.rollback": "\u56DE\u9000\u5230\u6B64\u524D",
  "action.editUser": "\u7F16\u8F91\u4E0A\u4E00\u7528\u6237\u6D88\u606F",
  "action.cancel": "\u53D6\u6D88",
  "action.confirm": "\u786E\u5B9A",
  "action.close": "\u5173\u95ED",
  "action.retry": "\u91CD\u8BD5",
  "action.clearSearch": "\u6E05\u7A7A\u641C\u7D22",
  "chip.unbound": "\u672A\u7ED1\u5B9A\u89D2\u8272",
  "hero.pickCharacter": "\u9009\u62E9\u89D2\u8272\u5361",
  "hero.noCharacters": "\u6682\u65E0\u89D2\u8272\u5361",
  "hero.emptyGreeting": "\u8BE5\u89D2\u8272\u6CA1\u6709\u5F00\u573A\u767D",
  "binding.save": "\u4FDD\u5B58\u7ED1\u5B9A",
  "binding.greeting": "\u63D2\u5165\u5F00\u573A\u767D",
  "binding.swipe": "\u5F00\u573A\u767D swipe",
  "binding.triggerLog": "\u89E6\u53D1\u65E5\u5FD7",
  "binding.preview": "\u9884\u89C8\u63D0\u793A\u8BCD",
  "interactive.open": "\u6253\u5F00\u4EA4\u4E92\u5361",
  "common.searchPlaceholder": "\u641C\u7D22\u2026",
  "common.noMatch": "\u6CA1\u6709\u5339\u914D\u7684{what}",
  "common.noMatchDesc": "\u300C{query}\u300D\u6CA1\u6709\u547D\u4E2D\u4EFB\u4F55\u6761\u76EE\uFF0C\u53EF\u6362\u4E2A\u5173\u952E\u8BCD\u6216",
  "common.unlimited": "\u4E0D\u9650",
  "common.copy": "\u590D\u5236",
  "common.copied": "\u5DF2\u590D\u5236",
  "common.markdownFootnotes": "\u811A\u6CE8"
};
var en5 = {
  "settings.label": "Tavern",
  "section.characters": "Characters",
  "section.presets": "Prompt Presets",
  "section.lorebooks": "Lorebooks",
  "section.personas": "User",
  "section.regex": "Regex Scripts",
  "section.memory": "Memory & World State",
  "section.sampling": "Sampling",
  "section.worldInfo": "World Info Settings",
  "action.import": "Import",
  "action.delete": "Delete",
  "action.detail": "Detail",
  "action.save": "Save",
  "action.new": "New",
  "action.edit": "Edit",
  "action.refresh": "Refresh",
  "action.regenerate": "Regenerate",
  "action.rollback": "Rollback to before",
  "action.editUser": "Edit last user message",
  "action.cancel": "Cancel",
  "action.confirm": "OK",
  "action.close": "Close",
  "action.retry": "Retry",
  "action.clearSearch": "Clear search",
  "chip.unbound": "No character bound",
  "hero.pickCharacter": "Select character",
  "hero.noCharacters": "No character cards",
  "hero.emptyGreeting": "This character has no greeting",
  "binding.save": "Save binding",
  "binding.greeting": "Insert greeting",
  "binding.swipe": "Greeting swipe",
  "binding.triggerLog": "Trigger log",
  "binding.preview": "Preview prompt",
  "interactive.open": "Open interactive card",
  "common.searchPlaceholder": "Search\u2026",
  "common.noMatch": "No matching {what}",
  "common.noMatchDesc": '"{query}" matched nothing. Try another keyword or',
  "common.unlimited": "Unlimited",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.markdownFootnotes": "Footnotes"
};

// lib/client/locales/hero.js
var zh6 = {
  "hero.characterFallback": "\u89D2\u8272",
  "hero.loadingCharacters": "\u52A0\u8F7D\u89D2\u8272\u5361\u2026",
  "hero.creator": "\u4F5C\u8005 {name}",
  "hero.start": "\u5F00\u59CB\u5BF9\u8BDD",
  "hero.prevGreeting": "\u4E0A\u4E00\u6761\u5F00\u573A\u767D",
  "hero.nextGreeting": "\u4E0B\u4E00\u6761\u5F00\u573A\u767D",
  "hero.swipeHint": "\u2190 \u2192 \u5207\u6362",
  "hero.error.emptyGreetingVariant": "\u5F53\u524D\u5F00\u573A\u767D\u4E3A\u7A7A\uFF0C\u8BF7\u5148\u5207\u6362\u53D8\u4F53",
  "hero.error.noGreetingInput": "\u8BE5\u89D2\u8272\u6CA1\u6709\u5F00\u573A\u767D\uFF0C\u8BF7\u76F4\u63A5\u5728\u4E0B\u65B9\u8F93\u5165",
  "hero.error.enterFailed": "\u672A\u80FD\u5199\u5165\u5F00\u573A\u767D\u3002\u4F1A\u8BDD\u91CC\u5DF2\u6709\u5185\u5BB9\u65F6\u8BF7\u76F4\u63A5\u7EE7\u7EED\u5BF9\u8BDD\u3002",
  "hero.detailLoadFailed": "\u89D2\u8272\u8BE6\u60C5\u52A0\u8F7D\u5931\u8D25\u3002\u53EF\u91CD\u65B0\u9009\u62E9\u89D2\u8272\uFF0C\u6216\u76F4\u63A5\u5728\u4E0B\u65B9\u8F93\u5165\u3002",
  "hero.emptyVariantHint": "\u5F53\u524D\u8FD9\u6761\u5F00\u573A\u767D\u4E3A\u7A7A\uFF0C\u53EF\u5207\u6362\u53D8\u4F53\u3002",
  "hero.noGreetingHint": "\u8BE5\u89D2\u8272\u6CA1\u6709\u5F00\u573A\u767D\u3002\u53EF\u4EE5\u76F4\u63A5\u5728\u4E0B\u65B9\u8F93\u5165\u3002",
  "hero.pickBook.withCount": "{name}\uFF08\u5185\u5D4C\u4E16\u754C\u4E66 \xB7 {count} \u6761\uFF09",
  "hero.pickBook.noCount": "{name}\uFF08\u5185\u5D4C\u4E16\u754C\u4E66\uFF09"
};
var en6 = {
  "hero.characterFallback": "Character",
  "hero.loadingCharacters": "Loading characters\u2026",
  "hero.creator": "By {name}",
  "hero.start": "Start chat",
  "hero.prevGreeting": "Previous greeting",
  "hero.nextGreeting": "Next greeting",
  "hero.swipeHint": "\u2190 \u2192 to switch",
  "hero.error.emptyGreetingVariant": "The current greeting is empty. Switch to another variant first.",
  "hero.error.noGreetingInput": "This character has no greeting. Type below to start.",
  "hero.error.enterFailed": "Could not insert the greeting. If the conversation already has content, just continue chatting.",
  "hero.detailLoadFailed": "Failed to load character details. Pick another character, or type below to start.",
  "hero.emptyVariantHint": "This greeting is empty. Switch to another variant.",
  "hero.noGreetingHint": "This character has no greeting. You can type below to start.",
  "hero.pickBook.withCount": "{name} (embedded book \xB7 {count} entries)",
  "hero.pickBook.noCount": "{name} (embedded book)"
};

// lib/client/locales/lorebookEditor.js
var zh7 = {
  "lorebookEditor.kind.character": "\u89D2\u8272\u5361\u5185\u5D4C",
  "lorebookEditor.kind.chat": "\u672C\u4F1A\u8BDD\u4E16\u754C\u4E66",
  "lorebookEditor.kind.library": "\u4E16\u754C\u4E66\u5E93",
  "lorebookEditor.meta": "{kind} \xB7 {total} \u6761 \xB7 \u542F\u7528 {enabled}",
  "lorebookEditor.metaConstant": " \xB7 \u5E38\u9A7B {count}",
  "lorebookEditor.unsaved": "\u672A\u4FDD\u5B58",
  "lorebookEditor.backToList": "\u8FD4\u56DE\u5217\u8868",
  "lorebookEditor.back": "\u8FD4\u56DE",
  "lorebookEditor.discardAndBack": "\u653E\u5F03\u5E76\u8FD4\u56DE",
  "lorebookEditor.newEntry": "\u65B0\u5EFA\u6761\u76EE",
  "lorebookEditor.searchPlaceholder": "\u641C\u7D22\u6761\u76EE\u540D\u3001\u5173\u952E\u8BCD\u6216\u6B63\u6587\u2026",
  "lorebookEditor.filter.all": "\u5168\u90E8 {count}",
  "lorebookEditor.filter.on": "\u542F\u7528 {count}",
  "lorebookEditor.filter.off": "\u5173\u95ED {count}",
  "lorebookEditor.filter.constant": "\u5E38\u9A7B {count}",
  "lorebookEditor.enableFiltered": "\u542F\u7528\u7B5B\u9009\u7ED3\u679C",
  "lorebookEditor.disableFiltered": "\u5173\u95ED\u7B5B\u9009\u7ED3\u679C",
  "lorebookEditor.empty": "\u8FD8\u6CA1\u6709\u6761\u76EE\uFF0C\u70B9\u300C\u65B0\u5EFA\u6761\u76EE\u300D\u5F00\u59CB\u3002",
  "lorebookEditor.entryNoun": "\u6761\u76EE",
  "lorebookEditor.entry.untitled": "\u672A\u547D\u540D\u6761\u76EE",
  "lorebookEditor.entry.order": "\u987A\u5E8F {order}",
  "lorebookEditor.entry.group": "\u7EC4 {group}",
  "lorebookEditor.entry.keys": "{count} \u952E",
  "lorebookEditor.entry.noKeys": "\u65E0\u5173\u952E\u8BCD",
  "lorebookEditor.entry.enable": "\u542F\u7528\u6B64\u6761\u76EE",
  "lorebookEditor.entry.disable": "\u5173\u95ED\u6B64\u6761\u76EE",
  "lorebookEditor.constant": "\u5E38\u9A7B",
  "lorebookEditor.pager.prev": "\u4E0A\u4E00\u9875",
  "lorebookEditor.pager.next": "\u4E0B\u4E00\u9875",
  "lorebookEditor.pager.status": "{page} / {pageCount} \u9875\uFF08\u672C\u9875 {count} \u6761\uFF09",
  "lorebookEditor.deleteEntry": "\u5220\u9664\u6761\u76EE",
  "lorebookEditor.delete.title": "\u5220\u9664\u8FD9\u6761\u4E16\u754C\u4E66\uFF1F",
  "lorebookEditor.delete.desc": "\u5220\u9664\u540E\u9700\u70B9\u300C\u4FDD\u5B58\u300D\u624D\u4F1A\u5199\u56DE\u6587\u4EF6\u3002\u53EF\u5148\u8FD4\u56DE\u5217\u8868\u653E\u5F03\u66F4\u6539\u3002",
  "lorebookEditor.discard.title": "\u653E\u5F03\u672A\u4FDD\u5B58\u7684\u66F4\u6539\uFF1F",
  "lorebookEditor.discard.desc": "\u5F00\u5173\u548C\u7F16\u8F91\u8FD8\u6CA1\u6709\u5199\u56DE\u4E16\u754C\u4E66\u6587\u4EF6\u3002",
  "lorebookEditor.discard.confirm": "\u653E\u5F03\u66F4\u6539",
  "lorebookEditor.position.0": "\u89D2\u8272\u5B9A\u4E49\u4E4B\u524D",
  "lorebookEditor.position.1": "\u89D2\u8272\u5B9A\u4E49\u4E4B\u540E",
  "lorebookEditor.position.2": "\u4F5C\u8005\u6CE8\u91CA\u9876\u90E8",
  "lorebookEditor.position.3": "\u4F5C\u8005\u6CE8\u91CA\u5E95\u90E8",
  "lorebookEditor.position.4": "@D \u6307\u5B9A\u6DF1\u5EA6",
  "lorebookEditor.position.5": "\u793A\u4F8B\u5BF9\u8BDD\u4E4B\u524D",
  "lorebookEditor.position.6": "\u793A\u4F8B\u5BF9\u8BDD\u4E4B\u540E",
  "lorebookEditor.position.7": "Outlet",
  "lorebookEditor.logic.0": "AND ANY\uFF08\u4EFB\u4E00\uFF09",
  "lorebookEditor.logic.1": "NOT ALL",
  "lorebookEditor.logic.2": "NOT ANY",
  "lorebookEditor.logic.3": "AND ALL\uFF08\u5168\u90E8\uFF09",
  "lorebookEditor.tri.follow": "\u8DDF\u968F\u5168\u5C40",
  "lorebookEditor.tri.on": "\u5F00",
  "lorebookEditor.tri.off": "\u5173",
  "lorebookEditor.form.comment": "\u6761\u76EE\u6807\u9898\uFF08comment\uFF09",
  "lorebookEditor.form.commentPlaceholder": "\u7ED9\u81EA\u5DF1\u770B\u7684\u540D\u5B57\uFF0C\u4F8B\u5982\u300C\u4E3B\u89D2\u8EAB\u4E16\u300D",
  "lorebookEditor.form.keys": "\u5173\u952E\u8BCD\uFF08\u9017\u53F7\u5206\u9694\uFF09",
  "lorebookEditor.form.keysPlaceholder": "\u547D\u4E2D\u8FD9\u4E9B\u8BCD\u65F6\u6CE8\u5165",
  "lorebookEditor.form.content": "\u5185\u5BB9",
  "lorebookEditor.form.contentPlaceholder": "\u5199\u5165\u63D0\u793A\u8BCD\u7684\u6B63\u6587",
  "lorebookEditor.form.constant": "\u5E38\u9A7B\uFF08\u4E0D\u9700\u5173\u952E\u8BCD\uFF09",
  "lorebookEditor.form.selective": "\u542F\u7528\u6B21\u7EA7\u952E",
  "lorebookEditor.form.ignoreBudget": "\u5FFD\u7565\u9884\u7B97",
  "lorebookEditor.form.position": "\u63D2\u5165\u4F4D\u7F6E",
  "lorebookEditor.form.order": "\u987A\u5E8F order",
  "lorebookEditor.form.depth": "\u6DF1\u5EA6 depth",
  "lorebookEditor.form.outletName": "Outlet \u540D",
  "lorebookEditor.form.secondaryKeys": "\u6B21\u7EA7\u5173\u952E\u8BCD",
  "lorebookEditor.form.secondaryKeysPlaceholder": "\u4E0E\u4E3B\u5173\u952E\u8BCD\u7EC4\u5408\u5224\u5B9A",
  "lorebookEditor.form.selectiveLogic": "\u6B21\u7EA7\u952E\u903B\u8F91",
  "lorebookEditor.form.advanced.show": "\u66F4\u591A\u9009\u9879\uFF08\u5339\u914D / \u6982\u7387 / \u9012\u5F52 / \u5B9A\u65F6 / \u5206\u7EC4\uFF09",
  "lorebookEditor.form.advanced.hide": "\u6536\u8D77\u66F4\u591A\u9009\u9879",
  "lorebookEditor.form.probability": "\u6982\u7387",
  "lorebookEditor.form.useProbability": "\u542F\u7528\u6982\u7387",
  "lorebookEditor.form.role": "@D \u89D2\u8272",
  "lorebookEditor.form.excludeRecursion": "\u4E0D\u53EF\u88AB\u9012\u5F52\u6FC0\u6D3B",
  "lorebookEditor.form.preventRecursion": "\u6FC0\u6D3B\u540E\u505C\u6B62\u9012\u5F52",
  "lorebookEditor.form.delayUntilRecursion": "\u5EF6\u8FDF\u5230\u9012\u5F52\u5C42",
  "lorebookEditor.form.scanDepth": "\u626B\u63CF\u6DF1\u5EA6\uFF08\u7A7A=\u8DDF\u968F\u5168\u5C40\uFF09",
  "lorebookEditor.form.caseSensitive": "\u533A\u5206\u5927\u5C0F\u5199",
  "lorebookEditor.form.matchWholeWords": "\u6574\u8BCD\u5339\u914D",
  "lorebookEditor.form.group": "\u5206\u7EC4",
  "lorebookEditor.form.groupWeight": "\u7EC4\u6743\u91CD",
  "lorebookEditor.form.groupOverride": "\u7EC4\u5185\u4F18\u5148\uFF08\u8986\u76D6\u540C\u7EC4\u5176\u5B83\u6761\u76EE\uFF09"
};
var en7 = {
  "lorebookEditor.kind.character": "Character-embedded",
  "lorebookEditor.kind.chat": "Chat lorebook",
  "lorebookEditor.kind.library": "Lorebook library",
  "lorebookEditor.meta": "{kind} \xB7 {total} entries \xB7 {enabled} enabled",
  "lorebookEditor.metaConstant": " \xB7 {count} constant",
  "lorebookEditor.unsaved": "Unsaved",
  "lorebookEditor.backToList": "Back to list",
  "lorebookEditor.back": "Back",
  "lorebookEditor.discardAndBack": "Discard and go back",
  "lorebookEditor.newEntry": "New entry",
  "lorebookEditor.searchPlaceholder": "Search title, keywords, or content\u2026",
  "lorebookEditor.filter.all": "All ({count})",
  "lorebookEditor.filter.on": "Enabled ({count})",
  "lorebookEditor.filter.off": "Disabled ({count})",
  "lorebookEditor.filter.constant": "Constant ({count})",
  "lorebookEditor.enableFiltered": "Enable filtered",
  "lorebookEditor.disableFiltered": "Disable filtered",
  "lorebookEditor.empty": 'No entries yet. Click "New entry" to start.',
  "lorebookEditor.entryNoun": "entries",
  "lorebookEditor.entry.untitled": "Untitled entry",
  "lorebookEditor.entry.order": "Order {order}",
  "lorebookEditor.entry.group": "Group {group}",
  "lorebookEditor.entry.keys": "{count} keys",
  "lorebookEditor.entry.noKeys": "No keywords",
  "lorebookEditor.entry.enable": "Enable this entry",
  "lorebookEditor.entry.disable": "Disable this entry",
  "lorebookEditor.constant": "Constant",
  "lorebookEditor.pager.prev": "Previous",
  "lorebookEditor.pager.next": "Next",
  "lorebookEditor.pager.status": "Page {page} of {pageCount} ({count} on this page)",
  "lorebookEditor.deleteEntry": "Delete entry",
  "lorebookEditor.delete.title": "Delete this lorebook entry?",
  "lorebookEditor.delete.desc": 'Deletion is written back to the file only after you click "Save". You can go back to the list to discard changes.',
  "lorebookEditor.discard.title": "Discard unsaved changes?",
  "lorebookEditor.discard.desc": "Toggles and edits have not been written back to the lorebook file.",
  "lorebookEditor.discard.confirm": "Discard changes",
  "lorebookEditor.position.0": "Before character definition",
  "lorebookEditor.position.1": "After character definition",
  "lorebookEditor.position.2": "Author's note top",
  "lorebookEditor.position.3": "Author's note bottom",
  "lorebookEditor.position.4": "@D at depth",
  "lorebookEditor.position.5": "Before example messages",
  "lorebookEditor.position.6": "After example messages",
  "lorebookEditor.position.7": "Outlet",
  "lorebookEditor.logic.0": "AND ANY",
  "lorebookEditor.logic.1": "NOT ALL",
  "lorebookEditor.logic.2": "NOT ANY",
  "lorebookEditor.logic.3": "AND ALL",
  "lorebookEditor.tri.follow": "Follow global",
  "lorebookEditor.tri.on": "On",
  "lorebookEditor.tri.off": "Off",
  "lorebookEditor.form.comment": "Entry title (comment)",
  "lorebookEditor.form.commentPlaceholder": `A name for yourself, e.g. "Hero's origin"`,
  "lorebookEditor.form.keys": "Keywords (comma-separated)",
  "lorebookEditor.form.keysPlaceholder": "Injected when these words match",
  "lorebookEditor.form.content": "Content",
  "lorebookEditor.form.contentPlaceholder": "Body text written into the prompt",
  "lorebookEditor.form.constant": "Constant (no keywords needed)",
  "lorebookEditor.form.selective": "Enable secondary keys",
  "lorebookEditor.form.ignoreBudget": "Ignore budget",
  "lorebookEditor.form.position": "Insertion position",
  "lorebookEditor.form.order": "Order",
  "lorebookEditor.form.depth": "Depth",
  "lorebookEditor.form.outletName": "Outlet name",
  "lorebookEditor.form.secondaryKeys": "Secondary keywords",
  "lorebookEditor.form.secondaryKeysPlaceholder": "Combined with primary keys for matching",
  "lorebookEditor.form.selectiveLogic": "Secondary key logic",
  "lorebookEditor.form.advanced.show": "More options (matching / probability / recursion / timers / groups)",
  "lorebookEditor.form.advanced.hide": "Hide advanced options",
  "lorebookEditor.form.probability": "Probability",
  "lorebookEditor.form.useProbability": "Use probability",
  "lorebookEditor.form.role": "@D role",
  "lorebookEditor.form.excludeRecursion": "Cannot be activated by recursion",
  "lorebookEditor.form.preventRecursion": "Stop recursion after activation",
  "lorebookEditor.form.delayUntilRecursion": "Delay until recursion depth",
  "lorebookEditor.form.scanDepth": "Scan depth (empty = follow global)",
  "lorebookEditor.form.caseSensitive": "Case sensitive",
  "lorebookEditor.form.matchWholeWords": "Match whole words",
  "lorebookEditor.form.group": "Group",
  "lorebookEditor.form.groupWeight": "Group weight",
  "lorebookEditor.form.groupOverride": "Group override (takes priority over other entries in the group)"
};

// lib/client/locales/lorebooks.js
var zh8 = {
  "lorebooks.listDesc": "\u5E93\u6587\u4EF6\u4E0E\u89D2\u8272\u5361\u5185\u5D4C\u4E66\u3002\u70B9\u5F00\u4E00\u672C\u4E66\uFF0C\u6309\u6761\u76EE\u5F00\u5173\u3001\u6539\u5173\u952E\u8BCD\u548C\u6B63\u6587\u3002\u65B0\u4F1A\u8BDD\u542F\u7528\u54EA\u672C\uFF0C\u5728\u300C\u8BBE\u7F6E\u300D\u9875\u52FE\u9009\u3002",
  "lorebooks.editorDesc": "\u6309\u6761\u76EE\u5F00\u5173\u4E0E\u7F16\u8F91\u3002\u5173\u6389\u7684\u6761\u76EE\u4E0D\u4F1A\u518D\u88AB\u626B\u63CF\u547D\u4E2D\u3002\u6539\u5B8C\u540E\u8BB0\u5F97\u4FDD\u5B58\u3002",
  "lorebooks.importJson": "\u5BFC\u5165\u4E16\u754C\u4E66 JSON",
  "lorebooks.newEmpty": "\u65B0\u5EFA\u7A7A\u4E66",
  "lorebooks.searchLabel": "\u641C\u7D22\u4E16\u754C\u4E66",
  "lorebooks.searchPlaceholder": "\u641C\u7D22\u4E66\u540D / \u89D2\u8272\u540D",
  "lorebooks.groupEmbedded": "\u89D2\u8272\u5361\u5185\u5D4C",
  "lorebooks.groupLibrary": "\u4E16\u754C\u4E66\u5E93",
  "lorebooks.badgeEmbedded": "\u5185\u5D4C",
  "lorebooks.badgeLibrary": "\u5E93",
  "lorebooks.fromCharacter": "\u6765\u81EA\u89D2\u8272\u300C{name}\u300D",
  "lorebooks.fromCharacterWithCount": "\u6765\u81EA\u89D2\u8272\u300C{name}\u300D \xB7 {count} \u6761",
  "lorebooks.libraryFileSub": "\u72EC\u7ACB\u4E16\u754C\u4E66\u6587\u4EF6 \xB7 JSON",
  "lorebooks.editEntries": "\u7F16\u8F91\u6761\u76EE",
  "lorebooks.exportJson": "\u5BFC\u51FA JSON",
  "lorebooks.deleteBook": "\u5220\u9664\u4E16\u754C\u4E66",
  "lorebooks.deleteEmbedded": "\u5220\u9664\u5185\u5D4C\u4E16\u754C\u4E66",
  "lorebooks.emptyTitle": "\u6682\u65E0\u72EC\u7ACB\u4E16\u754C\u4E66",
  "lorebooks.emptyDesc": "\u5BFC\u5165\u89D2\u8272\u5361\u6216 JSON\uFF0C\u4E5F\u53EF\u4EE5\u65B0\u5EFA\u4E00\u672C\u7A7A\u4E66\u3002",
  "lorebooks.emptyDescEmbeddedAbove": "\u5361\u5185\u5D4C\u4E66\u89C1\u4E0A\u65B9\u5206\u7EC4\u3002",
  "lorebooks.confirmDeleteTitle": "\u5220\u9664\u4E16\u754C\u4E66\uFF1F",
  "lorebooks.confirmDeleteDesc": "\u786E\u5B9A\u5220\u9664\u4E16\u754C\u4E66 {name}\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u80FD\u4ECE\u8BBE\u7F6E\u91CC\u64A4\u9500\u3002",
  "lorebooks.confirmDeleteEmbeddedTitle": "\u5220\u9664\u5185\u5D4C\u4E16\u754C\u4E66\uFF1F",
  "lorebooks.confirmDeleteEmbeddedDesc": "\u786E\u5B9A\u5220\u9664\u89D2\u8272\u300C{name}\u300D\u7684\u5185\u5D4C\u4E16\u754C\u4E66{book}\uFF1F\u89D2\u8272\u5361\u672C\u8EAB\u4FDD\u7559\uFF0C\u6B64\u64CD\u4F5C\u4E0D\u80FD\u4ECE\u8BBE\u7F6E\u91CC\u64A4\u9500\u3002",
  "lorebooks.bookNameSuffix": "\uFF08{name}\uFF09",
  "lorebooks.createTitle": "\u65B0\u5EFA\u4E16\u754C\u4E66",
  "lorebooks.createDesc": "\u5148\u5EFA\u4E00\u672C\u7A7A\u4E66\uFF0C\u518D\u5728\u6761\u76EE\u5217\u8868\u91CC\u6DFB\u52A0\u5173\u952E\u8BCD\u548C\u6B63\u6587\u3002",
  "lorebooks.create": "\u521B\u5EFA",
  "lorebooks.namePlaceholder": "\u4E16\u754C\u4E66\u540D\u79F0",
  "lorebooks.nameRequired": "\u8BF7\u586B\u5199\u4E16\u754C\u4E66\u540D\u79F0",
  "lorebooks.imported": "\u5DF2\u5BFC\u5165 {name}\uFF08{count} \u6761\uFF09",
  "lorebooks.saved": "\u5DF2\u4FDD\u5B58\u300C{name}\u300D",
  "lorebooks.embeddedDeleted": "\u5DF2\u5220\u9664\u300C{name}\u300D\u7684\u5185\u5D4C\u4E16\u754C\u4E66"
};
var en8 = {
  "lorebooks.listDesc": "Library files and character-embedded books. Open a book to toggle entries and edit keywords and content. Choose which books new sessions use on the Settings tab.",
  "lorebooks.editorDesc": "Toggle and edit per entry. Disabled entries are never hit by scans. Remember to save your changes.",
  "lorebooks.importJson": "Import lorebook JSON",
  "lorebooks.newEmpty": "New empty book",
  "lorebooks.searchLabel": "Search lorebooks",
  "lorebooks.searchPlaceholder": "Search book / character names",
  "lorebooks.groupEmbedded": "Character-embedded",
  "lorebooks.groupLibrary": "Lorebook library",
  "lorebooks.badgeEmbedded": "Embedded",
  "lorebooks.badgeLibrary": "Library",
  "lorebooks.fromCharacter": 'From character "{name}"',
  "lorebooks.fromCharacterWithCount": 'From character "{name}" \xB7 {count} entries',
  "lorebooks.libraryFileSub": "Standalone lorebook file \xB7 JSON",
  "lorebooks.editEntries": "Edit entries",
  "lorebooks.exportJson": "Export JSON",
  "lorebooks.deleteBook": "Delete lorebook",
  "lorebooks.deleteEmbedded": "Delete embedded lorebook",
  "lorebooks.emptyTitle": "No standalone lorebooks yet",
  "lorebooks.emptyDesc": "Import a character card or a JSON file, or create an empty book.",
  "lorebooks.emptyDescEmbeddedAbove": "Character-embedded books are in the group above.",
  "lorebooks.confirmDeleteTitle": "Delete lorebook?",
  "lorebooks.confirmDeleteDesc": "Delete lorebook {name}? This cannot be undone from settings.",
  "lorebooks.confirmDeleteEmbeddedTitle": "Delete embedded lorebook?",
  "lorebooks.confirmDeleteEmbeddedDesc": 'Delete the embedded lorebook{book} of character "{name}"? The character card itself is kept. This cannot be undone from settings.',
  "lorebooks.bookNameSuffix": " ({name})",
  "lorebooks.createTitle": "New lorebook",
  "lorebooks.createDesc": "Create an empty book first, then add keywords and content in the entry list.",
  "lorebooks.create": "Create",
  "lorebooks.namePlaceholder": "Lorebook name",
  "lorebooks.nameRequired": "Please enter a lorebook name",
  "lorebooks.imported": "Imported {name} ({count} entries)",
  "lorebooks.saved": 'Saved "{name}"',
  "lorebooks.embeddedDeleted": 'Deleted the embedded lorebook of "{name}"'
};

// lib/client/locales/memory.js
var zh9 = {
  "memory.story": "\u5267\u60C5\u72B6\u6001",
  "memory.storyDesc": "\u5404\u4F1A\u8BDD\u548C\u5206\u652F\u72EC\u7ACB\u4FDD\u5B58\u8BB0\u5FC6\u3001\u53D8\u5316\u5C42\u4E0E\u7B14\u8BB0\u3002\u521D\u59CB\u72B6\u6001\u53EA\u5F71\u54CD\u4EE5\u540E\u65B0\u5EFA\u7684\u4F1A\u8BDD\u3002",
  "memory.initialState": "\u521D\u59CB\u72B6\u6001\uFF08\u65B0\u4F1A\u8BDD\u6A21\u677F\uFF09",
  "memory.desc": "\u6309\u89D2\u8272\u67E5\u770B\u548C\u7F16\u8F91\u957F\u671F\u8BB0\u5FC6\u3001\u4E16\u754C\u72B6\u6001\u53D8\u5316\u5C42\u3001\u89D2\u8272\u7B14\u8BB0 journal.md\u3002",
  "memory.character": "\u89D2\u8272",
  "memory.characterDesc": "\u9009\u62E9\u8981\u67E5\u770B\u7684\u89D2\u8272\u5361\u5DE5\u4F5C\u533A\u3002",
  "memory.pickCharacter": "\uFF08\u9009\u62E9\u89D2\u8272\uFF09",
  "memory.tab.memory": "\u8BB0\u5FC6\uFF08{count}\uFF09",
  "memory.tab.delta": "\u4E16\u754C\u72B6\u6001\uFF08{count}\uFF09",
  "memory.tab.journal": "\u89D2\u8272\u7B14\u8BB0",
  "memory.compressOldest": "\u5F52\u5E76\u6700\u65E7\u4E00\u6279",
  "memory.compressed": "\u5DF2\u65E0\u635F\u5F52\u5E76\u6700\u65E7 {count} \u6761\u8BB0\u5FC6\uFF08\u539F\u6587\u4ECD\u53EF\u6062\u590D\uFF09",
  "memory.compressNoop": "\u8BB0\u5FC6\u4E0D\u8DB3\u4E24\u6761\uFF0C\u65E0\u9700\u5F52\u5E76",
  "memory.exportBook": "\u5BFC\u51FA\u5408\u5E76\u540E\u7684\u4E16\u754C\u4E66",
  "memory.bookExported": "\u5DF2\u5BFC\u51FA\u5408\u5E76\u540E\u7684\u4E16\u754C\u4E66",
  "memory.emptyMemories": "\u6682\u65E0\u8BB0\u5FC6",
  "memory.emptyMemoriesDesc": "\u8BA9\u6A21\u578B\u7528 tavern_memory_write \u5199\u5165\uFF0C\u6216\u5728\u4E0B\u65B9\u624B\u52A8\u6DFB\u52A0\u3002",
  "memory.archived": "\u5DF2\u5F52\u6863",
  "memory.collapseEdit": "\u6536\u8D77\u7F16\u8F91",
  "memory.deleteEntry": "\u5220\u9664\u8BB0\u5FC6",
  "memory.tags": "\u6807\u7B7E",
  "memory.keys": "\u68C0\u7D22\u952E",
  "memory.newPlaceholder": "\u65B0\u589E\u8BB0\u5FC6\u2026",
  "memory.addEntry": "\u6DFB\u52A0\u8BB0\u5FC6",
  "memory.emptyDeltas": "\u6682\u65E0\u4E16\u754C\u72B6\u6001\u53D8\u5316",
  "memory.emptyDeltasDesc": "\u6A21\u578B\u7ECF tavern_worldstate_update \u5199\u5165\uFF0C\u6216\u5728\u4E0B\u65B9\u624B\u52A8\u6DFB\u52A0\u3002",
  "memory.revoke": "\u64A4\u9500",
  "memory.revoked": "\u5DF2\u64A4\u9500",
  "memory.revokeDone": "\u5DF2\u64A4\u9500\u4E16\u754C\u72B6\u6001 #{id}",
  "memory.deltaType": "\u7C7B\u578B",
  "memory.deltaType.add": "\u65B0\u589E",
  "memory.deltaType.update": "\u66F4\u65B0",
  "memory.deltaType.invalidate": "\u4F5C\u5E9F",
  "memory.deltaRef": "\u539F\u6761\u76EE uid",
  "memory.deltaBodyPlaceholder": "\u4E16\u754C\u72B6\u6001\u6B63\u6587\u2026",
  "memory.deltaKeys": "\u89E6\u53D1\u952E\uFF08\u9017\u53F7\u5206\u9694\uFF0C\u53EF\u7A7A\uFF09",
  "memory.addDelta": "\u6DFB\u52A0\u4E16\u754C\u72B6\u6001",
  "memory.deltaAdded": "\u5DF2\u65B0\u589E\u4E16\u754C\u72B6\u6001 #{id}",
  "memory.journalHint": "\u5199\u5728\u89D2\u8272\u5DE5\u4F5C\u533A journal.md\u3002\u4F1A\u8BDD\u82AF\u7247\u6253\u5F00\u300C\u6CE8\u5165\u89D2\u8272\u7B14\u8BB0\u300D\u540E\u624D\u4F1A\u8FDB\u672C\u8F6E turn\u3002",
  "memory.saveJournal": "\u4FDD\u5B58\u7B14\u8BB0",
  "memory.journalSaved": "\u5DF2\u4FDD\u5B58\u89D2\u8272\u7B14\u8BB0",
  "memory.opFailed": "\u64CD\u4F5C\u5931\u8D25\uFF1A{message}"
};
var en9 = {
  "memory.story": "Story state",
  "memory.storyDesc": "Each session and branch has independent memories, changes and notes. Initial state applies to future sessions.",
  "memory.initialState": "Initial state (new session template)",
  "memory.desc": "View and edit long-term memory, world-state deltas and the character journal (journal.md), per character.",
  "memory.character": "Character",
  "memory.characterDesc": "Select the character workspace to view.",
  "memory.pickCharacter": "(Select a character)",
  "memory.tab.memory": "Memory ({count})",
  "memory.tab.delta": "World State ({count})",
  "memory.tab.journal": "Journal",
  "memory.compressOldest": "Merge oldest batch",
  "memory.compressed": "Losslessly merged the oldest {count} memories (originals remain recoverable)",
  "memory.compressNoop": "Fewer than two memories; nothing to merge",
  "memory.exportBook": "Export merged lorebook",
  "memory.bookExported": "Merged lorebook exported",
  "memory.emptyMemories": "No memories yet",
  "memory.emptyMemoriesDesc": "Let the model write with tavern_memory_write, or add one manually below.",
  "memory.archived": "Archived",
  "memory.collapseEdit": "Collapse editor",
  "memory.deleteEntry": "Delete memory",
  "memory.tags": "Tags",
  "memory.keys": "Retrieval keys",
  "memory.newPlaceholder": "New memory\u2026",
  "memory.addEntry": "Add memory",
  "memory.emptyDeltas": "No world state changes yet",
  "memory.emptyDeltasDesc": "The model writes via tavern_worldstate_update, or add one manually below.",
  "memory.revoke": "Revoke",
  "memory.revoked": "Revoked",
  "memory.revokeDone": "World state #{id} revoked",
  "memory.deltaType": "Type",
  "memory.deltaType.add": "Add",
  "memory.deltaType.update": "Update",
  "memory.deltaType.invalidate": "Invalidate",
  "memory.deltaRef": "Original entry uid",
  "memory.deltaBodyPlaceholder": "World state body\u2026",
  "memory.deltaKeys": "Trigger keys (comma-separated, optional)",
  "memory.addDelta": "Add world state",
  "memory.deltaAdded": "World state #{id} added",
  "memory.journalHint": 'Written to journal.md in the character workspace. It only enters the current turn when "Inject character journal" is enabled on the session chip.',
  "memory.saveJournal": "Save journal",
  "memory.journalSaved": "Character journal saved",
  "memory.opFailed": "Operation failed: {message}"
};

// lib/client/locales/panel.js
var zh10 = {
  "panel.tab.characters": "\u89D2\u8272",
  "panel.tab.presets": "\u9884\u8BBE",
  "panel.tab.lorebooks": "\u4E16\u754C\u4E66",
  "panel.tab.personas": "\u7528\u6237",
  "panel.tab.regex": "\u6B63\u5219",
  "panel.tab.memory": "\u8BB0\u5FC6",
  "panel.tab.settings": "\u8BBE\u7F6E"
};
var en10 = {
  "panel.tab.characters": "Characters",
  "panel.tab.presets": "Presets",
  "panel.tab.lorebooks": "Lorebooks",
  "panel.tab.personas": "User",
  "panel.tab.regex": "Regex",
  "panel.tab.memory": "Memory",
  "panel.tab.settings": "Settings"
};

// lib/client/locales/personas.js
var zh11 = {
  "personas.sectionDesc": "\u7528\u6237\u4FA7\u4EBA\u8BBE\uFF0C\u540D\u5B57\u4F1A\u66FF\u6362 {{user}}\u3002\u5E93\u91CC\u53EA\u6709\u4E00\u6761\u65F6\uFF0C\u672A\u7ED1\u4EBA\u8BBE\u7684\u4F1A\u8BDD\u4E5F\u4F1A\u81EA\u52A8\u7528\u5B83\uFF1B\u591A\u6761\u65F6\u8BF7\u5728\u300C\u8BBE\u7F6E\u300D\u9875\u6216\u5BF9\u8BDD\u82AF\u7247\u91CC\u9009\u62E9\u3002",
  "personas.new": "\u65B0\u5EFA\u4EBA\u8BBE",
  "personas.searchLabel": "\u641C\u7D22\u4EBA\u8BBE",
  "personas.searchPlaceholder": "\u641C\u7D22\u4EBA\u8BBE\u540D / \u63CF\u8FF0",
  "personas.entity": "\u4EBA\u8BBE",
  "personas.emptyTitle": "\u6682\u65E0\u4EBA\u8BBE",
  "personas.emptyDesc": "\u65B0\u5EFA\u4E00\u6761\u4EBA\u8BBE\uFF0C\u5BF9\u8BDD\u91CC\u7684 {{user}} \u5C31\u4F1A\u6362\u6210\u5B83\u3002",
  "personas.noDescription": "\u8FD8\u6CA1\u6709\u586B\u5199\u4EBA\u8BBE\u63CF\u8FF0\u3002",
  "personas.setDefault": "\u8BBE\u4E3A\u9ED8\u8BA4",
  "personas.delete": "\u5220\u9664\u4EBA\u8BBE",
  "personas.deleteTitle": "\u5220\u9664\u4EBA\u8BBE\uFF1F",
  "personas.deleteDesc": "\u786E\u5B9A\u5220\u9664\u4EBA\u8BBE\u300C{name}\u300D\uFF1F",
  "personas.nameRequired": "\u4EBA\u8BBE\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A",
  "personas.saved": "\u5DF2\u4FDD\u5B58\u4EBA\u8BBE {name}",
  "personas.defaultSet": "\u5DF2\u8BBE\u4E3A\u65B0\u4F1A\u8BDD\u9ED8\u8BA4\u4EBA\u8BBE\uFF08\u5F53\u524D\u6253\u5F00\u7684\u5BF9\u8BDD\u8BF7\u7528\u89D2\u8272\u82AF\u7247\u5207\u6362\uFF09",
  "personas.field.name": "\u540D\u79F0",
  "personas.field.description": "\u63CF\u8FF0",
  "personas.field.lorebook": "\u4EBA\u8BBE\u4E16\u754C\u4E66",
  "personas.lorebookNone": "\uFF08\u65E0\uFF09"
};
var en11 = {
  "personas.sectionDesc": "User-side personas; the name replaces {{user}}. If the library holds exactly one, sessions without a bound persona use it automatically; with more than one, pick one on the Settings page or via the chat chip.",
  "personas.new": "New persona",
  "personas.searchLabel": "Search personas",
  "personas.searchPlaceholder": "Search persona name / description",
  "personas.entity": "personas",
  "personas.emptyTitle": "No personas yet",
  "personas.emptyDesc": "Create a persona and {{user}} in conversations will be replaced with it.",
  "personas.noDescription": "No persona description yet.",
  "personas.setDefault": "Set as default",
  "personas.delete": "Delete persona",
  "personas.deleteTitle": "Delete persona?",
  "personas.deleteDesc": 'Delete persona "{name}"?',
  "personas.nameRequired": "Persona name cannot be empty",
  "personas.saved": "Persona {name} saved",
  "personas.defaultSet": "Set as the default persona for new sessions (use the character chip to switch in already-open conversations)",
  "personas.field.name": "Name",
  "personas.field.description": "Description",
  "personas.field.lorebook": "Persona lorebook",
  "personas.lorebookNone": "(none)"
};

// lib/client/locales/presets.js
var zh12 = {
  "presets.section.desc": "\u5BFC\u5165 SillyTavern \u9884\u8BBE JSON\uFF08\u542B extensions.regex_scripts\uFF09\u3002\u65B0\u4F1A\u8BDD\u9ED8\u8BA4\u5728\u300C\u8BBE\u7F6E\u300D\u9875\u6216\u5361\u811A\u300C\u8BBE\u4E3A\u9ED8\u8BA4\u300D\uFF1B\u5F53\u524D\u5BF9\u8BDD\u7528\u89D2\u8272\u82AF\u7247\u5207\u6362\u3002\u5DF2\u5728\u5E93\u4E2D\u7684\u9884\u8BBE\u9700\u91CD\u65B0\u5BFC\u5165\u624D\u4F1A\u5E26\u4E0A\u6B63\u5219\u3002",
  "presets.importFile": "\u5BFC\u5165 SillyTavern \u9884\u8BBE JSON",
  "presets.new": "\u65B0\u5EFA\u9884\u8BBE",
  "presets.searchLabel": "\u641C\u7D22\u9884\u8BBE",
  "presets.searchPlaceholder": "\u641C\u7D22\u9884\u8BBE\u540D / \u6807\u8BC6",
  "presets.noun": "\u9884\u8BBE",
  "presets.empty": "\u6682\u65E0\u9884\u8BBE",
  "presets.emptyDesc": "\u672A\u7ED1\u5B9A\u65F6\u4F7F\u7528\u5185\u5EFA\u9ED8\u8BA4\u9884\u8BBE\uFF1B\u4E5F\u53EF\u4EE5\u5BFC\u5165 SillyTavern \u9884\u8BBE JSON\u3002",
  "presets.regexCount": "{count} \u6761\u6B63\u5219",
  "presets.export": "\u5BFC\u51FA JSON",
  "presets.setAsDefault": "\u8BBE\u4E3A\u9ED8\u8BA4",
  "presets.delete": "\u5220\u9664\u9884\u8BBE",
  "presets.deleteTitle": "\u5220\u9664\u9884\u8BBE\uFF1F",
  "presets.deleteDesc": "\u786E\u5B9A\u5220\u9664\u9884\u8BBE {id}\uFF1F",
  "presets.saved": "\u5DF2\u4FDD\u5B58\u9884\u8BBE {name}",
  "presets.imported": "\u5DF2\u5BFC\u5165\u9884\u8BBE",
  "presets.importedWarnings": "\u5DF2\u5BFC\u5165\uFF0C\u8B66\u544A\uFF1A{warnings}",
  "presets.warningSep": "\uFF1B",
  "presets.setDefaultDone": "\u5DF2\u8BBE\u4E3A\u65B0\u4F1A\u8BDD\u9ED8\u8BA4\u9884\u8BBE\uFF08\u5F53\u524D\u6253\u5F00\u7684\u5BF9\u8BDD\u8BF7\u7528\u89D2\u8272\u82AF\u7247\u5207\u6362\uFF09",
  "presets.newPresetName": "\u65B0\u9884\u8BBE",
  "presets.name": "\u540D\u79F0",
  "presets.identifier": "\u6807\u8BC6",
  "presets.addEntry": "\u6DFB\u52A0\u6761\u76EE",
  "presets.save": "\u4FDD\u5B58\u9884\u8BBE",
  "presets.newEntryName": "\u65B0\u6761\u76EE",
  "presets.entry.disable": "\u5173\u95ED\u6B64\u6761\u76EE",
  "presets.entry.enable": "\u542F\u7528\u6B64\u6761\u76EE",
  "presets.entry.depth": "\u6DF1\u5EA6",
  "presets.entry.order": "\u987A\u5E8F",
  "presets.entry.marker": "\u5360\u4F4D\u7B26",
  "presets.entry.content": "\u5185\u5BB9",
  "presets.entry.delete": "\u5220\u9664\u6761\u76EE",
  "presets.regexList.label": "\u968F\u9884\u8BBE\u5BFC\u5165\u7684\u6B63\u5219\uFF08{count} \u6761\uFF1B\u5F00\u5173\u968F\u300C\u4FDD\u5B58\u9884\u8BBE\u300D\u751F\u6548\uFF0C\u91CD\u65B0\u5BFC\u5165\u4EE5\u6587\u4EF6\u4E3A\u51C6\uFF09"
};
var en12 = {
  "presets.section.desc": 'Import SillyTavern preset JSON (including extensions.regex_scripts). Set the default for new sessions on the Settings tab or via "Set as default" on a card; switch the current conversation via the character chip. Presets already in the library must be re-imported to pick up regex scripts.',
  "presets.importFile": "Import SillyTavern preset JSON",
  "presets.new": "New preset",
  "presets.searchLabel": "Search presets",
  "presets.searchPlaceholder": "Search preset name / identifier",
  "presets.noun": "presets",
  "presets.empty": "No presets yet",
  "presets.emptyDesc": "The built-in default preset is used while unbound; you can also import SillyTavern preset JSON.",
  "presets.regexCount": "{count} regex rules",
  "presets.export": "Export JSON",
  "presets.setAsDefault": "Set as default",
  "presets.delete": "Delete preset",
  "presets.deleteTitle": "Delete preset?",
  "presets.deleteDesc": "Delete preset {id}?",
  "presets.saved": "Preset {name} saved",
  "presets.imported": "Preset imported",
  "presets.importedWarnings": "Imported with warnings: {warnings}",
  "presets.warningSep": "; ",
  "presets.setDefaultDone": "Set as the default preset for new sessions (switch open conversations via the character chip)",
  "presets.newPresetName": "New preset",
  "presets.name": "Name",
  "presets.identifier": "Identifier",
  "presets.addEntry": "Add entry",
  "presets.save": "Save preset",
  "presets.newEntryName": "New entry",
  "presets.entry.disable": "Disable this entry",
  "presets.entry.enable": "Enable this entry",
  "presets.entry.depth": "Depth",
  "presets.entry.order": "Order",
  "presets.entry.marker": "Marker",
  "presets.entry.content": "Content",
  "presets.entry.delete": "Delete entry",
  "presets.regexList.label": 'Regex rules bundled with this preset ({count}); toggles take effect on "Save preset", and re-importing follows the file.'
};

// lib/client/locales/regex.js
var zh13 = {
  "regex.liveNotice": "\u5B9E\u9645\u4F1A\u8BDD\u53EA\u5E94\u7528 output/render \u5C55\u793A\u89C4\u5219\u3002input/send\u3001prompt/assemble \u548C prompt/send \u7528\u4E8E ST \u6A21\u62DF\u4E0E\u4EE3\u7B54\uFF0C\u4E0D\u4F1A\u6539\u5199\u5BBF\u4E3B\u5165\u6A21\u5386\u53F2\u3002",
  "regex.scope.input": "\u7528\u6237\u8F93\u5165",
  "regex.scope.output": "AI \u8F93\u51FA",
  "regex.scope.prompt": "\u53D1\u9001\u7ED9\u6A21\u578B",
  "regex.timing.assemble": "\u7EC4\u88C5\u524D",
  "regex.timing.send": "\u53D1\u9001\u524D",
  "regex.timing.render": "\u6E32\u67D3\u524D",
  "regex.source.user": "\u7528\u6237",
  "regex.source.card": "\u89D2\u8272\u5361",
  "regex.source.preset": "\u9884\u8BBE",
  "regex.newRuleName": "\u65B0\u89C4\u5219",
  "regex.toggleDisable": "\u5173\u95ED\u6B64\u89C4\u5219",
  "regex.toggleEnable": "\u542F\u7528\u6B64\u89C4\u5219",
  "regex.deleteRule": "\u5220\u9664\u89C4\u5219",
  "regex.find": "\u67E5\u627E (find)",
  "regex.replace": "\u66FF\u6362 (replace)",
  "regex.scope": "\u4F5C\u7528\u57DF",
  "regex.timing": "\u65F6\u673A",
  "regex.minDepth": "\u6700\u5C0F\u6DF1\u5EA6",
  "regex.maxDepth": "\u6700\u5927\u6DF1\u5EA6",
  "regex.macroExpand": "\u5B8F\u5C55\u5F00",
  "regex.substitute.none": "\u4E0D\u5C55\u5F00",
  "regex.substitute.raw": "\u539F\u6837\u4EE3\u5165",
  "regex.substitute.escaped": "\u8F6C\u4E49\u4EE3\u5165",
  "regex.toggledOn": "\u5DF2\u542F\u7528\u300C{name}\u300D",
  "regex.toggledOff": "\u5DF2\u5173\u95ED\u300C{name}\u300D",
  "regex.saved": "\u5DF2\u4FDD\u5B58 {count} \u6761\u89C4\u5219",
  "regex.desc": "\u5BF9\u8BDD\u5C55\u793A\u4F1A\u81EA\u52A8\u6536\u8D77 UpdateVariable\u3001JSONPatch \u7B49\u673A\u8BFB\u6807\u7B7E\uFF0C\u4E0D\u4F9D\u8D56\u9884\u8BBE\u662F\u5426\u5E26\u4E86\u6B63\u5219\u3002\u4E0A\u65B9\u662F\u4F60\u989D\u5916\u8981\u6539\u5199\u5C55\u793A\u6216 ST \u6A21\u62DF\u7684\u89C4\u5219\uFF1B\u4E0B\u65B9\u5217\u51FA\u9884\u8BBE\u968F\u5E26\u7684\u6B63\u5219\uFF0C\u53EF\u76F4\u63A5\u5F00\u5173\u3002",
  "regex.emptyTitle": "\u6682\u65E0\u81EA\u5B9A\u4E49\u89C4\u5219",
  "regex.emptyDesc": "\u70B9\u300C\u65B0\u5EFA\u89C4\u5219\u300D\u6DFB\u52A0\u5C55\u793A\u6216 ST \u6A21\u62DF\u7684\u6539\u5199\u89C4\u5219\u3002",
  "regex.new": "\u65B0\u5EFA\u89C4\u5219",
  "regex.saveAll": "\u4FDD\u5B58\u5168\u90E8",
  "regex.discard": "\u653E\u5F03\u66F4\u6539\u5E76\u5237\u65B0",
  "regex.presetHead": "\u9884\u8BBE\u9644\u5E26",
  "regex.noPresetRegex": "\u6CA1\u6709\u9884\u8BBE\u643A\u5E26\u6B63\u5219\u3002\u9884\u8BBE JSON \u91CC extensions.regex_scripts \u4F1A\u968F\u5BFC\u5165\u5E26\u8FDB\u6765\uFF0C\u53EF\u5728\u300C\u9884\u8BBE\u300D\u9875\u67E5\u770B\u3002",
  "regex.presetCount": "{name}\uFF08{count} \u6761\uFF09"
};
var en13 = {
  "regex.liveNotice": "Live chats apply output/render display rules. input/send, prompt/assemble and prompt/send apply to ST simulation and impersonation; they do not rewrite host request history.",
  "regex.scope.input": "User input",
  "regex.scope.output": "AI output",
  "regex.scope.prompt": "Sent to model",
  "regex.timing.assemble": "Before assembly",
  "regex.timing.send": "Before sending",
  "regex.timing.render": "Before rendering",
  "regex.source.user": "User",
  "regex.source.card": "Character card",
  "regex.source.preset": "Preset",
  "regex.newRuleName": "New rule",
  "regex.toggleDisable": "Disable this rule",
  "regex.toggleEnable": "Enable this rule",
  "regex.deleteRule": "Delete rule",
  "regex.find": "Find",
  "regex.replace": "Replace",
  "regex.scope": "Scopes",
  "regex.timing": "Timing",
  "regex.minDepth": "Min depth",
  "regex.maxDepth": "Max depth",
  "regex.macroExpand": "Macro substitution",
  "regex.substitute.none": "None",
  "regex.substitute.raw": "Raw",
  "regex.substitute.escaped": "Escaped",
  "regex.toggledOn": 'Enabled "{name}"',
  "regex.toggledOff": 'Disabled "{name}"',
  "regex.saved": "Saved {count} rules",
  "regex.desc": "Chat display automatically collapses machine-readable tags such as UpdateVariable and JSONPatch, regardless of preset regex. Above are your extra rules for rewriting display or model input; below are regex scripts bundled with presets, toggleable in place.",
  "regex.emptyTitle": "No custom rules",
  "regex.emptyDesc": 'Click "New rule" to add a rewrite rule for display or model input.',
  "regex.new": "New rule",
  "regex.saveAll": "Save all",
  "regex.discard": "Discard changes & refresh",
  "regex.presetHead": "Bundled with presets",
  "regex.noPresetRegex": 'No preset carries regex scripts. extensions.regex_scripts in a preset JSON is imported along with it; see the "Presets" page.',
  "regex.presetCount": "{name} ({count})"
};

// lib/client/locales/settings.js
var zh14 = {
  "settings.title": "\u8BBE\u7F6E",
  "settings.sub.interface": "\u754C\u9762",
  "settings.sub.defaults": "\u9ED8\u8BA4\u914D\u7F6E",
  "settings.sub.sampling": "\u91C7\u6837\u4E0E\u601D\u8003",
  "settings.sub.worldinfo": "\u4E16\u754C\u4E66\u5F15\u64CE",
  "settings.sub.memory": "\u8BB0\u5FC6",
  "settings.sub.cards": "\u5361\u7247\u4E0E\u6570\u636E",
  "settings.interface.title": "\u754C\u9762",
  "settings.interface.desc": "\u672C\u63D2\u4EF6\u754C\u9762\u7684\u663E\u793A\u504F\u597D\uFF0C\u6539\u52A8\u7ACB\u5373\u751F\u6548\uFF1B\u4E0D\u5F71\u54CD\u5BBF\u4E3B\u754C\u9762\u4E0E\u5176\u5B83\u63D2\u4EF6\u3002",
  "settings.interface.language": "\u754C\u9762\u8BED\u8A00",
  "settings.interface.languageDesc": "\u9762\u677F\u3001\u5BF9\u8BDD\u82AF\u7247\u3001\u82F1\u96C4\u533A\u4E0E\u64CD\u4F5C\u6761\u7B49\u672C\u63D2\u4EF6\u6587\u6848\u7684\u8BED\u8A00\uFF1B\u9009\u62E9\u540E\u7ACB\u5373\u751F\u6548\u5E76\u81EA\u52A8\u4FDD\u5B58\u3002",
  "settings.interface.localeAuto": "\u8DDF\u968F\u5BBF\u4E3B\u8BED\u8A00",
  "settings.interface.languageFailed": "\u8BED\u8A00\u4FDD\u5B58\u5931\u8D25",
  "settings.defaults.title": "\u9009\u5361\u540E\u7684\u9ED8\u8BA4\u914D\u7F6E",
  "settings.defaults.desc": "\u5728\u65B0\u5BF9\u8BDD\u91CC\u70B9\u9009\u4EFB\u610F\u89D2\u8272\u5361\u540E\uFF0C\u4F1A\u5957\u7528\u8FD9\u91CC\u7684\u9884\u8BBE\u3001\u4E16\u754C\u4E66\u4E0E\u4EBA\u8BBE\u3002\u65B0\u5BF9\u8BDD\u4E0D\u4F1A\u81EA\u52A8\u9009\u89D2\u8272\uFF1B\u5DF2\u6253\u5F00\u7684\u4F1A\u8BDD\u8BF7\u7528\u5BF9\u8BDD\u9875\u89D2\u8272\u82AF\u7247\u4FEE\u6539\u3002",
  "settings.defaults.preset": "\u63D0\u793A\u8BCD\u9884\u8BBE",
  "settings.defaults.presetDesc": "\u5F53\u524D\u4F1A\u8BDD\u8BF7\u7528\u5BF9\u8BDD\u9875\u89D2\u8272\u82AF\u7247\u5207\u6362\u3002\u8FD9\u91CC\u53EA\u5F71\u54CD\u4E4B\u540E\u70B9\u9009\u89D2\u8272\u65F6\u7684\u9ED8\u8BA4\u503C\u3002",
  "settings.defaults.builtinPreset": "\uFF08\u5185\u5EFA\u9ED8\u8BA4\u9884\u8BBE\uFF09",
  "settings.defaults.presetRegexCount": "{name}\uFF08{count} \u6761\u6B63\u5219\uFF09",
  "settings.defaults.persona": "\u4EBA\u8BBE",
  "settings.defaults.personaDesc": "\u7528\u6237\u4FA7\u540D\u5B57\uFF08{{user}}\uFF09\u3002\u53EF\u7A7A\uFF1B\u82E5\u5E93\u91CC\u53EA\u6709\u4E00\u6761\u4EBA\u8BBE\uFF0C\u672A\u9009\u62E9\u65F6\u4E5F\u4F1A\u81EA\u52A8\u7528\u90A3\u6761\u3002",
  "settings.defaults.noPersona": "\uFF08\u65E0\u4EBA\u8BBE\uFF09",
  "settings.defaults.mainLore": "\u4E3B\u4E16\u754C\u4E66",
  "settings.defaults.mainLoreDesc": "Character Lore\u3002\u4E0D\u9009\u5219\u4F7F\u7528\u89D2\u8272\u5361\u5185\u5D4C\u4E16\u754C\u4E66\uFF08\u82E5\u5BFC\u5165\u65F6\u4FDD\u7559\u4E86\uFF09\u3002",
  "settings.defaults.embeddedLore": "\uFF08\u4F7F\u7528\u6240\u9009\u89D2\u8272\u7684\u5361\u5185\u5D4C\u4E66 / \u65E0\uFF09",
  "settings.defaults.globalLore": "\u5168\u5C40\u4E16\u754C\u4E66",
  "settings.defaults.globalLoreDesc": "\u53EF\u591A\u9009\uFF0C\u6BCF\u8F6E\u68C0\u7D22\u65F6\u4E0E\u4E3B\u4E16\u754C\u4E66\u4E00\u5E76\u626B\u63CF\u3002",
  "settings.defaults.noLorebooks": "\u5E93\u4E2D\u6682\u65E0\u72EC\u7ACB\u4E16\u754C\u4E66\u3002\u53EF\u5728\u300C\u4E16\u754C\u4E66\u300D\u9875\u5BFC\u5165\uFF0C\u6216\u4F7F\u7528\u89D2\u8272\u5361\u5185\u5D4C\u4E66\u3002",
  "settings.defaults.save": "\u4FDD\u5B58\u9ED8\u8BA4\u914D\u7F6E",
  "settings.defaults.saved": "\u5DF2\u4FDD\u5B58\u9009\u5361\u540E\u7684\u9ED8\u8BA4\u914D\u7F6E",
  "settings.sampling.title": "\u91C7\u6837\u4E0E\u601D\u8003",
  "settings.sampling.desc": "temperature / maxTokens / stop \u4F1A\u900F\u4F20\u5230\u6A21\u578B\uFF1BtopP \u4E0E penalty \u5F53\u524D\u5E73\u53F0\u4E0D\u751F\u6548\uFF0C\u4EC5\u4F5C\u8BB0\u5F55\u3002",
  "settings.sampling.temperatureDesc": "0\u20132\uFF0C\u9ED8\u8BA4 1\u3002thinking \u6A21\u5F0F\u4E0B\u4E0D\u751F\u6548\u3002",
  "settings.sampling.topPDesc": "0\u20131\u3002\u5F53\u524D dsh \u6A21\u578B\u670D\u52A1\u4E0D\u900F\u4F20\u3002",
  "settings.sampling.maxTokensDesc": "\u5355\u6B21\u751F\u6210\u6700\u5927 token\uFF1B0 = \u6CBF\u7528\u6A21\u578B\u9ED8\u8BA4\u3002",
  "settings.sampling.thinking": "\u6DF1\u5EA6\u601D\u8003",
  "settings.sampling.thinkingDesc": "\u5173\u95ED\uFF1A\u5BF9\u5F53\u524D\u6A21\u578B\u5199\u5165 off\uFF08\u82E5\u516C\u5E03\u8BE5\u6863\uFF09\u3002\u4F4E/\u9AD8/\u6700\u9AD8\uFF1A\u6A21\u578B\u516C\u5E03\u8BE5\u6863\u65F6\u663E\u5F0F\u6307\u5B9A\uFF0C\u5426\u5219\u56DE\u9000\u81EA\u52A8\u3002\u81EA\u52A8\uFF1A\u4FDD\u7559\u4F1A\u8BDD\u5DF2\u9009\u6863\u4F4D\uFF0C\u5426\u5219\u7528\u6A21\u578B\u9ED8\u8BA4\u2014\u2014\u6CE8\u610F\u6A21\u578B\u9ED8\u8BA4\u6863\u7684\u601D\u8003\u53EF\u80FD\u5F88\u77ED\uFF0C\u60F3\u8981\u66F4\u5145\u5206\u7684\u601D\u8003\u8BF7\u9009\u9AD8/\u6700\u9AD8\u3002\u90E8\u7F72\u628A thinking \u9501\u6210 disabled \u65F6\u65E0\u6CD5\u6253\u5F00\u3002thinking \u6A21\u5F0F\u4E0B\u6E29\u5EA6\u4E0D\u751F\u6548\u3002",
  "settings.sampling.thinking.disabled": "\u5173\u95ED",
  "settings.sampling.thinking.enabled": "\u81EA\u52A8",
  "settings.sampling.thinking.low": "\u4F4E",
  "settings.sampling.thinking.high": "\u9AD8",
  "settings.sampling.thinking.max": "\u6700\u9AD8",
  "settings.sampling.stop": "\u505C\u6B62\u5E8F\u5217",
  "settings.sampling.stopDesc": "\u6BCF\u884C\u4E00\u4E2A\u3002",
  "settings.sampling.save": "\u4FDD\u5B58\u91C7\u6837\u53C2\u6570",
  "settings.sampling.saved": "\u5DF2\u4FDD\u5B58\u91C7\u6837\u53C2\u6570",
  "settings.worldinfo.title": "\u4E16\u754C\u4E66\u5F15\u64CE",
  "settings.worldinfo.desc": "\u626B\u63CF\u6DF1\u5EA6\u3001\u9884\u7B97\u4E0E\u5408\u5E76\u7B56\u7565\uFF0C\u5BF9\u6240\u6709\u4F1A\u8BDD\u751F\u6548\u3002",
  "settings.worldinfo.scanDepth": "\u626B\u63CF\u6DF1\u5EA6 scanDepth",
  "settings.worldinfo.contextPercent": "\u9884\u7B97\u767E\u5206\u6BD4 contextPercent",
  "settings.worldinfo.contextPercentDesc": "\u4EC5\u5F53\u56FA\u5B9A\u9884\u7B97\u4E3A 0 \u65F6\u751F\u6548\uFF1B\u6309\u7A97\u53E3\u6298\u7B97\uFF08\u57FA\u6570\u4E0A\u9650 128K\uFF09\uFF0C\u5E76\u968F\u5386\u53F2\u957F\u5EA6\u6263\u51CF\u3002",
  "settings.worldinfo.tokenBudget": "\u56FA\u5B9A token \u9884\u7B97",
  "settings.worldinfo.tokenBudgetDesc": "\u672C\u8F6E\u4E16\u754C\u4E66\u5C42\u7684\u7EDD\u5BF9\u4E0A\u9650\uFF08\u9ED8\u8BA4 8192\uFF0C\u4F18\u5148\u4E8E\u767E\u5206\u6BD4\uFF09\u3002\u547D\u4E2D\u5185\u5BB9\u6BCF\u8F6E\u8D70 runtime context \u5FEB\u7167\u3001\u65E0\u6CD5\u547D\u4E2D\u524D\u7F00\u7F13\u5B58\uFF1B\u88AB\u88C1\u6761\u76EE\u53EF\u7528 tavern_lore_read \u6309\u6761\u8865\u8BFB\u3002",
  "settings.worldinfo.maxRecursionSteps": "\u6700\u5927\u626B\u63CF\u8F6E\u6570",
  "settings.worldinfo.maxRecursionStepsDesc": "\u542B\u9996\u8F6E\uFF1A1 = \u5173\u95ED\u9012\u5F52\uFF0C2 = \u9996\u8F6E\u52A0\u4E00\u8F6E\u9012\u5F52\uFF0C0 = \u4E0D\u9650\uFF08\u4EC5\u53D7\u9884\u7B97\u7EA6\u675F\uFF09\u3002",
  "settings.worldinfo.strategy": "\u5408\u5E76\u7B56\u7565",
  "settings.worldinfo.recursiveScan": "\u9012\u5F52\u626B\u63CF",
  "settings.worldinfo.recursiveScanDesc": "\u547D\u4E2D\u6761\u76EE\u7684\u5185\u5BB9\u7EE7\u7EED\u4F5C\u4E3A\u5173\u952E\u8BCD\u626B\u63CF\u3002",
  "settings.worldinfo.caseSensitive": "\u533A\u5206\u5927\u5C0F\u5199",
  "settings.worldinfo.matchWholeWords": "\u6574\u8BCD\u5339\u914D",
  "settings.worldinfo.matchWholeWordsDesc": "\u5BF9\u4E2D\u6587\u4E0D\u53CB\u597D\uFF0C\u5EFA\u8BAE\u5173\u95ED\u3002",
  "settings.worldinfo.includeNames": "\u626B\u63CF\u8BA1\u5165\u6D88\u606F\u540D\u524D\u7F00",
  "settings.worldinfo.overflowWarning": "\u9884\u7B97\u6EA2\u51FA\u544A\u8B66",
  "settings.worldinfo.useGroupScoring": "\u7EC4\u5185\u6309\u547D\u4E2D\u952E\u6570\u6311\u9009",
  "settings.worldinfo.useGroupScoringDesc": "\u5F00\u542F\u540E\u540C\u7EC4\u6309\u547D\u4E2D\u5173\u952E\u8BCD\u6570\u9009\u4E00\u6761\uFF1B\u5173\u95ED\u5219\u6309\u7EC4\u6743\u91CD\u968F\u673A\u3002",
  "settings.worldinfo.save": "\u4FDD\u5B58\u4E16\u754C\u4E66\u8BBE\u7F6E",
  "settings.worldinfo.saved": "\u5DF2\u4FDD\u5B58\u4E16\u754C\u4E66\u8BBE\u7F6E",
  "settings.memory.title": "\u8BB0\u5FC6",
  "settings.memory.desc": "BM25 \u957F\u671F\u8BB0\u5FC6\u7684\u5BB9\u91CF\u3001\u68C0\u7D22\u4E0E\u538B\u7F29\u53C2\u6570\uFF0C\u5BF9\u6240\u6709\u89D2\u8272\u751F\u6548\u3002",
  "settings.memory.maxEntries": "\u6761\u6570\u4E0A\u9650 maxEntries",
  "settings.memory.maxEntriesDesc": "\u6BCF\u89D2\u8272\u8BB0\u5FC6\u6761\u6570\u4E0A\u9650\uFF0C\u8D85\u51FA\u540E\u5728 turn \u7ED3\u675F\u7A7A\u95F2\u65F6\u5F02\u6B65\u538B\u7F29\u6700\u65E7\u6279\u6B21\u3002\u6700\u5C0F 1\u3002",
  "settings.memory.maxTokens": "token \u4E0A\u9650 maxTokens",
  "settings.memory.maxTokensDesc": "\u6BCF\u89D2\u8272\u8BB0\u5FC6\u7684\u4F30\u7B97 token \u4E0A\u9650\uFF0C\u8D85\u51FA\u540C\u6837\u89E6\u53D1\u538B\u7F29\u3002",
  "settings.memory.retrievalTopK": "\u68C0\u7D22\u6761\u6570 retrievalTopK",
  "settings.memory.retrievalTopKDesc": "\u6BCF\u8F6E BM25 \u68C0\u7D22\u6CE8\u5165 runtime context \u7684\u8BB0\u5FC6\u6761\u6570\uFF1B0 = \u4E0D\u6CE8\u5165\u3002",
  "settings.memory.retrievalTokenBudget": "\u68C0\u7D22\u9884\u7B97 retrievalTokenBudget",
  "settings.memory.retrievalTokenBudgetDesc": "\u6BCF\u8F6E\u68C0\u7D22\u6CE8\u5165\u7684\u4F30\u7B97 token \u9884\u7B97\u3002",
  "settings.memory.halfLifeDays": "\u65F6\u95F4\u8870\u51CF\u534A\u8870\u671F\uFF08\u5929\uFF09",
  "settings.memory.halfLifeDaysDesc": "\u68C0\u7D22\u6253\u5206\u65F6\u65E7\u8BB0\u5FC6\u6309\u534A\u8870\u671F\u964D\u6743\uFF1B0 = \u4E0D\u8870\u51CF\u3002",
  "settings.memory.dedupScore": "\u53BB\u91CD\u9608\u503C dedupScore",
  "settings.memory.dedupScoreDesc": "\u5199\u5165\u8BB0\u5FC6\u7684\u76F8\u4F3C\u5EA6\u9608\u503C\uFF08BM25 \u5206\uFF09\uFF0C\u8FBE\u5230\u5219\u89C6\u4E3A\u91CD\u590D\u4E0D\u5199\u5165\uFF1B\u8D8A\u9AD8\u8D8A\u4E0D\u5BB9\u6613\u5224\u91CD\u3002",
  "settings.memory.compressBatch": "\u538B\u7F29\u6279\u6B21 compressBatch",
  "settings.memory.compressBatchDesc": "\u6BCF\u6B21\u538B\u7F29\u5408\u5E76\u7684\u6700\u65E7\u6761\u6570\u3002\u6700\u5C0F 2\u3002",
  "settings.memory.queryMessages": "\u68C0\u7D22\u53D6\u8BCD queryMessages",
  "settings.memory.queryMessagesDesc": "BM25 \u68C0\u7D22\u7684 query \u53D6\u6700\u8FD1 N \u6761\u6D88\u606F\u3002\u6700\u5C0F 1\u3002",
  "settings.memory.save": "\u4FDD\u5B58\u8BB0\u5FC6\u8BBE\u7F6E",
  "settings.memory.saved": "\u5DF2\u4FDD\u5B58\u8BB0\u5FC6\u8BBE\u7F6E",
  "settings.cards.title": "\u89D2\u8272\u5361\u4E0E\u4EA4\u4E92\u5361",
  "settings.cards.desc": "\u5220\u5361\u8FDE\u5E26\u884C\u4E3A\u4E0E\u5C01\u9762 HTML \u7684\u7F51\u7EDC\u653E\u884C\u3002\u5C01\u9762\u9ED8\u8BA4\u5141\u8BB8\u52A0\u8F7D https \u56FE\u7247\u4E0E\u5B57\u4F53\uFF1B\u5361\u5185\u5207\u5F00\u573A\u767D\u8D70\u5BBF\u4E3B swipe\uFF0C\u4E0D\u5F00\u653E\u4E3B\u7A97\u53E3 API\u3002",
  "settings.cards.cascadeDelete": "\u8FDE\u540C\u5220\u9664\u5185\u5D4C\u4E16\u754C\u4E66",
  "settings.cards.cascadeDeleteDesc": "\u5F00\u542F\uFF1A\u5220\u9664\u89D2\u8272\u5361\u65F6\u5176\u5185\u5D4C\u4E16\u754C\u4E66\u4E00\u5E76\u5220\u9664\u3002\u5173\u95ED\uFF1A\u5220\u5361\u524D\u628A\u5185\u5D4C\u4E66\u4FDD\u7559\u5230\u4E16\u754C\u4E66\u5E93\uFF08\u91CD\u540D\u81EA\u52A8\u52A0\u5E8F\u53F7\uFF09\u3002",
  "settings.cards.interactiveCards": "\u4EA4\u4E92\u5361\u6E32\u67D3",
  "settings.cards.interactiveCardsDesc": "\u5173\u95ED\u540E\u5C01\u9762\u4E0E\u4EA4\u4E92\u5361\u4E00\u5F8B\u6309\u7EAF\u6587\u672C\u663E\u793A\u3002",
  "settings.cards.triggerLogMax": "\u89E6\u53D1\u65E5\u5FD7\u4FDD\u7559\u6761\u6570",
  "settings.cards.whitelist": "\u811A\u672C\u4FE1\u4EFB\u7684\u5916\u90E8\u57DF\u540D",
  "settings.cards.whitelistDesc": "\u5C01\u9762\u811A\u672C\u9ED8\u8BA4\u4E0D\u80FD fetch/XHR\u3001\u4E5F\u4E0D\u80FD\u52A0\u8F7D\u5916\u90E8\u811A\u672C\uFF1B\u6309\u884C\u586B\u5199\u57DF\u540D\u9010\u4E2A\u653E\u884C\uFF0C\u5355\u72EC\u4E00\u884C * \u8868\u793A\u5168\u90E8\u653E\u884C\u3002\u56FE\u7247\u548C\u5B57\u4F53\u9ED8\u8BA4\u5DF2\u653E\u884C https\u3002",
  "settings.cards.save": "\u4FDD\u5B58\u5361\u7247\u8BBE\u7F6E",
  "settings.cards.saved": "\u5DF2\u4FDD\u5B58\u5361\u7247\u8BBE\u7F6E",
  "settings.cards.dataHome": "\u6570\u636E\u76EE\u5F55",
  "settings.cards.dataHomeDesc": "\u89D2\u8272\u5361\u3001\u4E16\u754C\u4E66\u3001\u9884\u8BBE\u3001\u4EBA\u8BBE\u3001\u8BB0\u5FC6\u4E0E\u4F1A\u8BDD\u7ED1\u5B9A\u90FD\u843D\u5728\u8FD9\u4E2A\u76EE\u5F55\uFF0C\u53EF\u76F4\u63A5\u67E5\u770B\u5907\u4EFD\uFF1A"
};
var en14 = {
  "settings.title": "Settings",
  "settings.sub.interface": "Interface",
  "settings.sub.defaults": "Defaults",
  "settings.sub.sampling": "Sampling & Thinking",
  "settings.sub.worldinfo": "World Info Engine",
  "settings.sub.memory": "Memory",
  "settings.sub.cards": "Cards & Data",
  "settings.interface.title": "Interface",
  "settings.interface.desc": "Display preferences for this plugin UI. Changes apply immediately and do not affect the host UI or other plugins.",
  "settings.interface.language": "Language",
  "settings.interface.languageDesc": "Language of this plugin\u2019s panels, chat chips, hero area and action bars. Applies immediately and is saved automatically.",
  "settings.interface.localeAuto": "Follow host language",
  "settings.interface.languageFailed": "Failed to save language",
  "settings.defaults.title": "Defaults after picking a character",
  "settings.defaults.desc": "Applied when you pick any character card in a new conversation: preset, lorebooks and persona. New conversations never auto-select a character; for open sessions use the character chip in the chat header.",
  "settings.defaults.preset": "Prompt preset",
  "settings.defaults.presetDesc": "For the current session, switch via the character chip in the chat header. This only sets the default for future character picks.",
  "settings.defaults.builtinPreset": "(built-in default preset)",
  "settings.defaults.presetRegexCount": "{name} ({count} regex rules)",
  "settings.defaults.persona": "Persona",
  "settings.defaults.personaDesc": "The user-side name ({{user}}). Optional; if the library holds exactly one persona, it is used even when unselected.",
  "settings.defaults.noPersona": "(no persona)",
  "settings.defaults.mainLore": "Primary lorebook",
  "settings.defaults.mainLoreDesc": "Character Lore. Leave unset to use the character-embedded lorebook (if kept on import).",
  "settings.defaults.embeddedLore": "(use the selected character\u2019s embedded book / none)",
  "settings.defaults.globalLore": "Global lorebooks",
  "settings.defaults.globalLoreDesc": "Multi-select; scanned together with the primary lorebook on every turn.",
  "settings.defaults.noLorebooks": "No standalone lorebooks in the library. Import one on the Lorebooks tab, or use a character-embedded book.",
  "settings.defaults.save": "Save defaults",
  "settings.defaults.saved": "Character-pick defaults saved",
  "settings.sampling.title": "Sampling & Thinking",
  "settings.sampling.desc": "temperature / maxTokens / stop are passed through to the model; topP and penalties currently have no effect on this platform and are only recorded.",
  "settings.sampling.temperatureDesc": "0\u20132, default 1. No effect in thinking mode.",
  "settings.sampling.topPDesc": "0\u20131. Not forwarded by the current dsh model service.",
  "settings.sampling.maxTokensDesc": "Max tokens per generation; 0 = keep the model default.",
  "settings.sampling.thinking": "Deep thinking",
  "settings.sampling.thinkingDesc": 'Off: writes "off" for the current model (if that tier is published). Low/High/Max: set explicitly when the model publishes the tier, otherwise falls back to auto. Auto: keeps the session\u2019s selected tier, else the model default \u2014 note the default tier may think very briefly; choose High/Max for deeper reasoning. Cannot be enabled when the deployment locks thinking to disabled. Temperature has no effect in thinking mode.',
  "settings.sampling.thinking.disabled": "Off",
  "settings.sampling.thinking.enabled": "Auto",
  "settings.sampling.thinking.low": "Low",
  "settings.sampling.thinking.high": "High",
  "settings.sampling.thinking.max": "Max",
  "settings.sampling.stop": "Stop sequences",
  "settings.sampling.stopDesc": "One per line.",
  "settings.sampling.save": "Save sampling",
  "settings.sampling.saved": "Sampling settings saved",
  "settings.worldinfo.title": "World Info Engine",
  "settings.worldinfo.desc": "Scan depth, budgets and merge strategy; applies to all sessions.",
  "settings.worldinfo.scanDepth": "Scan depth (scanDepth)",
  "settings.worldinfo.contextPercent": "Budget percent (contextPercent)",
  "settings.worldinfo.contextPercentDesc": "Only effective when the fixed budget is 0; converted from the context window (base clamped to 128K) and reduced by history length.",
  "settings.worldinfo.tokenBudget": "Fixed token budget",
  "settings.worldinfo.tokenBudgetDesc": "Absolute cap of this turn\u2019s world-info layer (default 8192, takes precedence over the percent). Hits travel in the runtime-context snapshot every turn and cannot hit the prefix cache; trimmed entries can be re-read individually with tavern_lore_read.",
  "settings.worldinfo.maxRecursionSteps": "Max scan rounds",
  "settings.worldinfo.maxRecursionStepsDesc": "Including the first round: 1 = recursion off, 2 = first round plus one recursion, 0 = unlimited (budget still applies).",
  "settings.worldinfo.strategy": "Merge strategy",
  "settings.worldinfo.recursiveScan": "Recursive scan",
  "settings.worldinfo.recursiveScanDesc": "Content of hit entries keeps being scanned as keywords.",
  "settings.worldinfo.caseSensitive": "Case sensitive",
  "settings.worldinfo.matchWholeWords": "Match whole words",
  "settings.worldinfo.matchWholeWordsDesc": "Unfriendly to Chinese; keeping it off is recommended.",
  "settings.worldinfo.includeNames": "Include message name prefixes in scan",
  "settings.worldinfo.overflowWarning": "Budget overflow warning",
  "settings.worldinfo.useGroupScoring": "Pick within group by hit count",
  "settings.worldinfo.useGroupScoringDesc": "On: within a group, pick the entry with the most keyword hits; off: random by group weight.",
  "settings.worldinfo.save": "Save world info settings",
  "settings.worldinfo.saved": "World info settings saved",
  "settings.memory.title": "Memory",
  "settings.memory.desc": "Capacity, retrieval and compression parameters of BM25 long-term memory; applies to all characters.",
  "settings.memory.maxEntries": "Max entries (maxEntries)",
  "settings.memory.maxEntriesDesc": "Per-character memory entry cap; overflow asynchronously compresses the oldest batch at turn-end idle. Minimum 1.",
  "settings.memory.maxTokens": "Token cap (maxTokens)",
  "settings.memory.maxTokensDesc": "Per-character estimated memory token cap; overflow also triggers compression.",
  "settings.memory.retrievalTopK": "Retrieval count (retrievalTopK)",
  "settings.memory.retrievalTopKDesc": "Memories injected into runtime context by BM25 retrieval each turn; 0 = inject nothing.",
  "settings.memory.retrievalTokenBudget": "Retrieval budget (retrievalTokenBudget)",
  "settings.memory.retrievalTokenBudgetDesc": "Estimated token budget injected per retrieval round.",
  "settings.memory.halfLifeDays": "Time-decay half-life (days)",
  "settings.memory.halfLifeDaysDesc": "Older memories lose retrieval score by half-life; 0 = no decay.",
  "settings.memory.dedupScore": "Dedup threshold (dedupScore)",
  "settings.memory.dedupScoreDesc": "Similarity threshold (BM25 score) for memory writes; at or above counts as duplicate and is skipped. Higher = harder to dedupe.",
  "settings.memory.compressBatch": "Compression batch (compressBatch)",
  "settings.memory.compressBatchDesc": "Oldest entries merged per compression run. Minimum 2.",
  "settings.memory.queryMessages": "Query messages (queryMessages)",
  "settings.memory.queryMessagesDesc": "BM25 query takes the most recent N messages. Minimum 1.",
  "settings.memory.save": "Save memory settings",
  "settings.memory.saved": "Memory settings saved",
  "settings.cards.title": "Characters & Interactive Cards",
  "settings.cards.desc": "Delete-cascade behavior and network allowances for cover HTML. Covers may load https images and fonts by default; in-card greeting switching goes through host swipe \u2014 no main-window API is exposed.",
  "settings.cards.cascadeDelete": "Delete embedded lorebook together",
  "settings.cards.cascadeDeleteDesc": "On: deleting a character card also deletes its embedded lorebook. Off: the embedded book is salvaged into the lorebook library before deletion (auto-numbered on name clash).",
  "settings.cards.interactiveCards": "Interactive card rendering",
  "settings.cards.interactiveCardsDesc": "Off: covers and interactive cards always render as plain text.",
  "settings.cards.triggerLogMax": "Trigger log retention",
  "settings.cards.whitelist": "External domains trusted by scripts",
  "settings.cards.whitelistDesc": "Cover scripts cannot fetch/XHR or load external scripts by default; list one domain per line to allow, or a single * line to allow all. Images and fonts over https are already allowed.",
  "settings.cards.save": "Save card settings",
  "settings.cards.saved": "Card settings saved",
  "settings.cards.dataHome": "Data directory",
  "settings.cards.dataHomeDesc": "Characters, lorebooks, presets, personas, memories and session bindings all live in this directory \u2014 open it directly for backups:"
};

// lib/client/locales/speech.js
var zh15 = {
  "speech.copied": "\u5DF2\u590D\u5236\u6D88\u606F\u6587\u672C",
  "speech.copyFailed": "\u590D\u5236\u5931\u8D25",
  "speech.copy": "\u590D\u5236\u6D88\u606F\u6587\u672C"
};
var en15 = {
  "speech.copied": "Message text copied",
  "speech.copyFailed": "Copy failed",
  "speech.copy": "Copy message text"
};

// lib/client/locales/util.js
var zh16 = {
  "util.regexScope.displayAndPrompt": "\u5C55\u793A + \u5165\u6A21",
  "util.regexScope.displayOnly": "\u4EC5\u5C55\u793A",
  "util.regexScope.promptOnly": "\u4EC5\u5165\u6A21",
  "util.regexScope.userInput": "\u7528\u6237\u8F93\u5165",
  "util.regexScope.aiOutput": "AI \u8F93\u51FA",
  "util.regexScope.worldInfo": "\u4E16\u754C\u4E66",
  "util.regex.disable": "\u5173\u95ED\u6B64\u6B63\u5219",
  "util.regex.enable": "\u542F\u7528\u6B64\u6B63\u5219",
  "util.regex.unnamed": "\u9884\u8BBE\u6B63\u5219 {index}",
  "util.regex.noFind": "\uFF08\u65E0\u67E5\u627E\u5F0F\uFF0C\u4E0D\u4F1A\u751F\u6548\uFF09",
  "util.loadTimeout": "\u52A0\u8F7D\u8D85\u65F6\uFF1A\u8FDC\u7A0B\u8C03\u7528\u4E00\u76F4\u6CA1\u6709\u8FD4\u56DE\u3002\u70B9\u300C\u5237\u65B0\u300D\u91CD\u8BD5\uFF1B\u53CD\u590D\u51FA\u73B0\u8BF7\u91CD\u8F7D\u9875\u9762\u6216\u91CD\u542F dsh web\u3002"
};
var en16 = {
  "util.regexScope.displayAndPrompt": "Display + prompt",
  "util.regexScope.displayOnly": "Display only",
  "util.regexScope.promptOnly": "Prompt only",
  "util.regexScope.userInput": "User input",
  "util.regexScope.aiOutput": "AI output",
  "util.regexScope.worldInfo": "World info",
  "util.regex.disable": "Disable this regex",
  "util.regex.enable": "Enable this regex",
  "util.regex.unnamed": "Preset regex {index}",
  "util.regex.noFind": "(no find pattern; never fires)",
  "util.loadTimeout": 'Load timed out: the remote call never returned. Click "Refresh" to retry; if it keeps happening, reload the page or restart dsh web.'
};

// lib/client/locales.js
var DEFAULT_LOCALE = "en";
var zh17 = {
  ...zh5,
  ...zh16,
  ...zh10,
  ...zh14,
  ...zh3,
  ...zh12,
  ...zh8,
  ...zh7,
  ...zh11,
  ...zh13,
  ...zh9,
  ...zh4,
  ...zh6,
  ...zh,
  ...zh2,
  ...zh15
};
var en17 = {
  ...en5,
  ...en16,
  ...en10,
  ...en14,
  ...en3,
  ...en12,
  ...en8,
  ...en7,
  ...en11,
  ...en13,
  ...en9,
  ...en4,
  ...en6,
  ...en,
  ...en2,
  ...en15
};

// lib/client/i18n.js
var preference = "auto";
var hostActive = "en";
var current = DEFAULT_LOCALE;
var listeners = /* @__PURE__ */ new Set();
function effectiveLocale() {
  if (preference !== "auto")
    return preference;
  return hostActive.toLowerCase().startsWith("zh") ? "zh" : "en";
}
function syncEffective() {
  const next = effectiveLocale();
  if (next === current)
    return;
  current = next;
  for (const fn of listeners)
    fn();
}
function getTavernLocale() {
  return current;
}
function setTavernLocale(id) {
  if (id === preference)
    return;
  preference = id;
  syncEffective();
}
function setTavernHostLocale(active) {
  if (!active || active === hostActive)
    return;
  hostActive = active;
  syncEffective();
}
function t(key, params) {
  const dict = current === "zh" ? zh17 : en17;
  const raw = dict[key] ?? zh17[key] ?? key;
  if (!params)
    return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name2) => name2 in params ? String(params[name2]) : match);
}
function useT() {
  (0, import_react.useSyncExternalStore)((fn) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, getTavernLocale);
  return t;
}
function useMarkdownLabels() {
  const t2 = useT();
  return {
    code: { copyLabel: t2("common.copy"), copiedLabel: t2("common.copied") },
    footnotes: t2("common.markdownFootnotes")
  };
}

// lib/core/tavernMode.js
var TAVERN_AGENT_PRESET = "tavern";
function isTavernPresetId(id) {
  if (!id)
    return false;
  const trimmed = id.trim();
  if (!trimmed)
    return false;
  const last = trimmed.split(/[/\\:]/).pop() ?? trimmed;
  return last === TAVERN_AGENT_PRESET;
}

// lib/client/mode.js
function readAgentPreset(useSessions, sessionId) {
  if (!useSessions)
    return void 0;
  return useSessions((s) => s.byId?.[sessionId]?.projectionValues?.agentPreset ?? void 0);
}
function isTavernSession(useSessions, sessionId) {
  return isTavernPresetId(readAgentPreset(useSessions, sessionId));
}
function isCurrentTavernSession(list) {
  const snap = list.getSnapshot();
  const id = snap.current;
  if (!id)
    return false;
  return isTavernPresetId(snap.byId?.[id]?.projectionValues?.agentPreset ?? void 0);
}

// lib/client/openChild.js
async function openChildSession(sessions, childId, title) {
  if (typeof sessions.refresh === "function") {
    try {
      await sessions.refresh();
    } catch {
    }
  }
  try {
    sessions.open(childId);
  } catch {
    if (typeof sessions.refresh === "function") {
      try {
        await sessions.refresh();
      } catch {
      }
    }
    sessions.open(childId);
  }
  if (title && typeof sessions.scope === "function" && typeof sessions.sessionOf === "function") {
    try {
      const face = sessions.sessionOf(sessions.scope(childId));
      await face?.rename(title);
    } catch {
    }
  }
}

// lib/client/util.js
var import_jsx_runtime = require("react/jsx-runtime");
var import_react2 = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// lib/client/styles.js
var STYLE_ID = "dsh-tavern-ui-style";
var STYLE = `
/* ========== \u57FA\u7840 ========== */
.dsh-tavern-ui{
  color:var(--dsw-alias-label-primary, inherit);color-scheme:inherit;
  /* Tavern \u8BC6\u522B\u8272\uFF1A\u84DD\uFF08solid/strong \u8DDF\u968F\u5BBF\u4E3B business-primary \u4EE4\u724C\uFF0C\u6DF1\u6D45\u8272\u81EA\u9002\u5E94\uFF09\u3002
     solid \u7528\u4E8E\u5F00\u5173/\u523B\u5EA6\u7B49\u5C0F\u9762\u79EF\uFF1Bsoft \u7CFB\u7528\u4E8E\u9009\u4E2D\u5E95\u8272\u4E0E\u56FE\u6807\u5EA7\u3002 */
  --tavern-accent:var(--dsw-alias-state-business-primary, #4176e6);
  --tavern-accent-strong:var(--dsw-alias-state-business-primary, #4176e6);
  --tavern-accent-soft:rgba(65,118,230,.12);
  --tavern-accent-softer:rgba(65,118,230,.07);
  --tavern-accent-border:rgba(65,118,230,.32);
}
.dsh-tavern-panel{max-width:880px}
.dsh-tavern-ui ::selection{background:var(--dsw-alias-bg-multi-select, rgba(84,85,87,.55));color:var(--dsw-alias-label-primary, #fff)}
.dsh-tavern-ui input,.dsh-tavern-ui textarea,.dsh-tavern-ui select{
  color:var(--dsw-alias-label-primary, CanvasText);
  background:var(--dsw-alias-bg-layer-2, Field);
  color-scheme:inherit;
}
.dsh-tavern-ui select option,.dsh-tavern-ui option{
  color:var(--dsw-alias-label-primary, CanvasText);
  background:var(--dsw-alias-bg-layer-2, Field);
}

/* ========== \u52A8\u6548\uFF08\u65F6\u957F/\u66F2\u7EBF\u8D70\u5BBF\u4E3B\u6863\u4F4D\uFF09 ========== */
@keyframes dsh-tavern-fade-up{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes dsh-tavern-spin{to{transform:rotate(360deg)}}
@keyframes dsh-tavern-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.dsh-tavern-rise{animation:dsh-tavern-fade-up var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-spin{display:inline-flex;animation:dsh-tavern-spin .9s linear infinite}
@media (prefers-reduced-motion: reduce){
  .dsh-tavern-ui *,.dsh-tavern-ui *::before,.dsh-tavern-ui *::after{
    animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}
}

/* ========== \u53EF\u8BBF\u95EE\u6027 ========== */
.dsh-tavern-ui button:focus-visible,.dsh-tavern-ui [role="button"]:focus-visible{
  outline:2px solid var(--dsw-alias-state-business-primary, #4176e6);outline-offset:2px}
.dsh-tavern-ui input:focus-visible,.dsh-tavern-ui textarea:focus-visible{
  outline:2px solid var(--dsw-alias-state-business-primary, #4176e6);outline-offset:-1px;border-color:transparent}

/* ========== \u6EDA\u52A8\u533A\uFF08\u5BF9\u9F50\u5BBF\u4E3B 8px \u6EDA\u52A8\u6761\u76AE\u80A4\uFF09 ========== */
.dsh-tavern-scroll{scrollbar-width:thin;
  scrollbar-color:var(--dsh-scrollbar-thumb, var(--dsw-alias-border-l3, rgba(128,128,128,.4))) transparent}
.dsh-tavern-scroll::-webkit-scrollbar{width:8px;height:8px}
.dsh-tavern-scroll::-webkit-scrollbar-thumb{
  background:var(--dsh-scrollbar-thumb, var(--dsw-alias-border-l3, rgba(128,128,128,.4)));border-radius:4px}
.dsh-tavern-scroll::-webkit-scrollbar-thumb:hover{
  background:var(--dsh-scrollbar-thumb-hover, var(--dsw-alias-border-l4, rgba(128,128,128,.55)))}
.dsh-tavern-scroll::-webkit-scrollbar-track{background:transparent}

/* ========== \u9762\u677F\u9AA8\u67B6 ========== */
.dsh-tavern-section{display:flex;flex-direction:column;gap:16px}
/* \u9875\u9762\u5934\uFF1A\u6807\u9898 + \u4E00\u53E5\u8BDD\u7B80\u4ECB\uFF0C\u548C\u5185\u5BB9\u4E4B\u95F4\u7559\u8DB3\u8DDD\u79BB\uFF0C\u4E0D\u518D\u6324\u5728\u4E00\u8D77 */
.dsh-tavern-pageHead{display:flex;flex-direction:column;gap:7px;margin:2px 0 6px;max-width:68ch}
.dsh-tavern-pageTitle{margin:0;font-size:19px;font-weight:600;line-height:27px;letter-spacing:.01em;
  color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-pageIntro{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-tertiary, inherit)}
.dsh-tavern-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:10px}
/* \u5206\u7EC4\u5C0F\u6807\u9898\uFF1A\u5DE6\u4FA7\u84DD\u8272\u5C0F\u523B\u5EA6\u662F Tavern \u7684\u7B7E\u540D\u5143\u7D20 */
.dsh-tavern-groupHead{display:flex;align-items:center;gap:8px;margin:22px 0 10px;
  font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-groupHead:before{content:"";flex:none;width:3px;height:12px;border-radius:2px;
  background:var(--tavern-accent, #4176e6)}
.dsh-tavern-groupHead:first-child{margin-top:0}

/* \u9875\u7B7E\u5BFC\u822A\uFF1A\u5706\u89D2\u5206\u6BB5\u63A7\u4EF6\uFF08pill track\uFF09\uFF0C\u533A\u522B\u4E8E\u5BBF\u4E3B\u901A\u7528\u8BBE\u7F6E\u7684\u4E0B\u5212\u7EBF\u9875\u7B7E */
.dsh-tavern-navPills{display:inline-flex;flex-wrap:wrap;gap:2px;max-width:100%;padding:4px;margin:2px 0 20px;
  border-radius:999px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))}
.dsh-tavern-navPill{appearance:none;height:30px;padding:0 15px;border:0;border-radius:999px;background:transparent;
  font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;
  color:var(--dsw-alias-label-tertiary, inherit);
  transition:color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    background var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-navPill:hover{color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-navPill[data-active="true"]{color:var(--dsw-alias-label-primary, inherit);
  background:var(--dsw-alias-bg-base, #fff);
  box-shadow:var(--dsw-shadow-lv1, 0 1px 3px rgba(0,0,0,.12))}
/* \u5B50\u5BFC\u822A\uFF08\u8BBE\u7F6E\u9875\u5185\u7684\u7B2C\u4E8C\u7EA7\uFF09\uFF1A\u540C\u8BED\u8A00\u5C0F\u4E00\u53F7 */
.dsh-tavern-navPills.is-sub{padding:3px;margin-bottom:18px}
.dsh-tavern-navPills.is-sub .dsh-tavern-navPill{height:26px;padding:0 12px;font-size:12px;line-height:18px}

/* ========== \u8BBE\u7F6E\u884C\uFF08\u6807\u9898 + \u8BF4\u660E + \u53F3\u4FA7\u80F6\u56CA\u63A7\u4EF6\uFF1B\u884C\u95F4\u7559\u9AD8\u3001\u5206\u9694\u7EBF\u538B\u6DE1\uFF09 ========== */
.dsh-tavern-row{display:flex;align-items:center;gap:16px;padding:18px 2px;
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14))}
.dsh-tavern-row:last-child{border-bottom:none}
.dsh-tavern-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;padding-right:48px}
.dsh-tavern-rowTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-rowDesc{font-size:12px;line-height:19px;color:var(--dsw-alias-label-tertiary, inherit)}
.dsh-tavern-rowControl{flex:none;min-width:0}
.dsh-tavern-rowControl .dsh-tavern-select{width:240px}
.dsh-tavern-row.is-stacked{flex-direction:column;align-items:stretch}
.dsh-tavern-row.is-stacked .dsh-tavern-rowText{padding-right:0}
.dsh-tavern-row.is-stacked .dsh-tavern-rowControl{width:100%}
.dsh-tavern-row.is-stacked .dsh-tavern-rowControl .dsh-tavern-select{width:100%}
/* \u5206\u7EC4\u4FDD\u5B58\u884C\uFF1A\u4E0E\u4E0A\u65B9\u8868\u5355\u4E00\u6761\u6DE1\u5206\u9694\uFF0C\u64CD\u4F5C\u5DE6\u9F50 */
.dsh-tavern-saveBar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:6px;padding-top:16px;
  border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14))}

/* ========== \u5361\u7247\u4E0E\u5217\u8868 ========== */
/* \u901A\u7528\u5361\u7247\u5BB9\u5668\uFF08\u9884\u8BBE/\u4EBA\u8BBE\u7684\u5185\u8054\u7F16\u8F91\u5361\u7B49\uFF09\uFF1B\u7F51\u683C\u7248\u6D77\u62A5\u5361\u4E0E\u74E6\u7247\u884C\u89C1\u540E\u6587\u4E13\u8282 */
.dsh-tavern-card{display:flex;flex-direction:column;gap:12px;padding:18px 20px;border-radius:16px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
  background:var(--dsw-alias-bg-layer-3, transparent);min-width:0;
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    background var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-card:hover{border-color:var(--dsw-alias-label-dimmed, #888)}
.dsh-tavern-card.is-clickable{cursor:pointer}
/* \u53EF\u70B9\u5361\u7247 hover \u8F7B\u62AC\u5347\u4E00\u50CF\u7D20 + \u4E00\u5C42\u6D45\u9634\u5F71\uFF0C:active \u843D\u56DE\uFF0C\u7ED9\u51FA\u300C\u8FD9\u5F20\u5361\u80FD\u70B9\u300D\u7684\u7269\u7406\u53CD\u9988 */
.dsh-tavern-card.is-clickable:hover,.dsh-tavern-card.is-clickable:focus-visible{
  border-color:var(--tavern-accent-border, rgba(65,118,230,.32));
  transform:translateY(-1px);box-shadow:var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.05))}
.dsh-tavern-card.is-clickable:active{transform:none;box-shadow:none}
.dsh-tavern-card.is-selected{border-color:var(--tavern-accent-border, rgba(65,118,230,.32));
  background:var(--tavern-accent-softer, rgba(65,118,230,.07))}
.dsh-tavern-cardName{flex:1;min-width:0;font-size:14px;font-weight:500;line-height:22px;
  color:var(--dsw-alias-label-primary, inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-badge{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 8px;border-radius:999px;
  font-size:11px;line-height:20px;color:var(--dsw-alias-label-secondary, inherit);
  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))}
.dsh-tavern-badge.is-accent{color:var(--tavern-accent-strong, #4176e6);
  background:var(--tavern-accent-softer, rgba(65,118,230,.07));
  border-color:var(--tavern-accent-border, rgba(65,118,230,.32))}
.dsh-tavern-badge.is-danger{color:var(--dsw-alias-state-error-primary, #ec1313);
  border-color:var(--dsw-alias-state-error-primary, #ec1313)}
.dsh-tavern-list{display:flex;flex-direction:column;gap:10px}

/* \u7A7A\u6001\uFF08\u5706\u5E95\u56FE\u6807 + \u6807\u9898 + \u8BF4\u660E\uFF09\uFF1B\u56FE\u6807\u5EA7\u7528\u84DD\u8272 soft\uFF0C\u662F\u7A7A\u9875\u91CC\u552F\u4E00\u7684\u8272\u5F69\u70B9 */
.dsh-tavern-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:52px 20px;text-align:center}
.dsh-tavern-empty.is-compact{padding:28px 14px}
.dsh-tavern-emptyIcon{display:flex;align-items:center;justify-content:center;width:64px;height:64px;margin-bottom:6px;
  border-radius:50%;background:var(--tavern-accent-soft, rgba(65,118,230,.12));
  color:var(--tavern-accent-strong, #4176e6)}
.dsh-tavern-emptyTitle{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-emptyDesc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary, inherit);max-width:44ch}

/* ========== \u5934\u50CF\uFF08img \u6216\u9996\u5B57\u7B26 fallback\uFF0C\u4E0D\u518D\u662F\u7070\u5757\uFF09 ========== */
.dsh-tavern-avatar{width:var(--tavern-avatar-s, 40px);height:var(--tavern-avatar-s, 40px);flex:none;
  border-radius:28%;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;
  background:var(--tavern-accent-soft, rgba(65,118,230,.12));color:var(--tavern-accent-strong, #4176e6);
  font-size:calc(var(--tavern-avatar-s, 40px) * .42);font-weight:500;line-height:1;user-select:none}
.dsh-tavern-avatar>img{width:100%;height:100%;object-fit:cover;display:block}

/* ========== \u63A7\u4EF6 ========== */
.dsh-tavern-file{display:inline-flex}
.dsh-tavern-select{display:block;width:100%;min-width:0;max-width:100%}
.dsh-tavern-select > span{display:block;width:100%}
/* 36px \u80F6\u56CA\u9009\u62E9\u5668\uFF08\u5BF9\u9F50\u901A\u7528\u8BBE\u7F6E\u7684 .selector\uFF09 */
.dsh-tavern-pillSelect{display:inline-flex;align-items:center;justify-content:space-between;gap:12px;
  width:100%;min-width:0;height:36px;padding:0 15px;border:0;border-radius:18px;cursor:pointer;text-align:left;
  background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.14));
  color:var(--dsw-alias-label-primary, inherit);font:inherit;font-size:14px;line-height:22px;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-pillSelect:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18))}
.dsh-tavern-pillSelect:disabled{opacity:.4;cursor:default}
.dsh-tavern-pillSelect.is-sm{height:28px;padding:0 10px;border-radius:14px;font-size:13px;line-height:20px}
.dsh-tavern-pillSelectLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-pillSelectChevron{flex:none;color:var(--dsw-alias-label-caption, #888);
  transition:transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-pillSelect[aria-expanded="true"] .dsh-tavern-pillSelectChevron{transform:rotate(180deg)}

/* \u5F00\u5173\uFF1A\u5F00\u542F\u6001\u843D\u84DD\u8272 accent\uFF0C\u662F\u63A7\u4EF6\u5C42\u552F\u4E00\u7684\u54C1\u724C\u8272\u51FA\u53E3 */
.dsh-tavern-toggle{appearance:none;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:20px;
  background:var(--dsw-alias-border-l4, rgba(128,128,128,.35));cursor:pointer;
  transition:background var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-toggle.is-on{background:var(--tavern-accent, #4176e6)}
.dsh-tavern-toggle:disabled{opacity:.4;cursor:default}
.dsh-tavern-toggle:after{content:"";display:block;width:16px;height:16px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18);
  transition:transform var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-toggle.is-on:after{transform:translateX(16px)}

/* 28px \u5706\u5F62\u5E7D\u7075\u56FE\u6807\u94AE\uFF08\u5BF9\u9F50\u5BBF\u4E3B\u6D88\u606F\u64CD\u4F5C\u94AE\uFF09 */
.dsh-tavern-iconBtn{width:28px;height:28px;padding:6px;border:none;border-radius:28px;display:inline-flex;
  align-items:center;justify-content:center;background:0 0;cursor:pointer;
  color:var(--dsw-alias-label-tertiary, inherit);
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16));
  color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-iconBtn.is-danger:hover{color:var(--dsw-alias-state-error-primary, #ec1313);
  background:var(--dsw-alias-interactive-bg-hover-danger, rgba(236,19,19,.06))}
.dsh-tavern-iconBtn:disabled{opacity:.4;cursor:default;background:0 0}

/* \u641C\u7D22\u6846\uFF0838px \u80F6\u56CA + \u524D\u5BFC\u56FE\u6807\uFF09 */
.dsh-tavern-search{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:38px;padding:0 14px;
  border-radius:19px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:var(--dsw-alias-bg-layer-2, transparent)}
.dsh-tavern-search:focus-within{border-color:var(--dsw-alias-state-business-primary, #4176e6)}
.dsh-tavern-search input{flex:1;min-width:0;border:0;background:transparent;padding:0;font:inherit;font-size:13px;
  outline:none;color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-search input:focus-visible{outline:none}
.dsh-tavern-search input::placeholder{color:var(--dsw-alias-label-caption, #888)}
.dsh-tavern-searchIcon{flex:none;color:var(--dsw-alias-label-tertiary, inherit)}
/* \u884C\u5185\u6587\u5B57\u6309\u94AE\uFF08\u7A7A\u7ED3\u679C\u6001\u7684\u300C\u6E05\u7A7A\u641C\u7D22\u300D\u7B49\uFF09\uFF1A\u7EE7\u627F\u6B63\u6587\u8272 + \u4E0B\u5212\u7EBF\u63D0\u793A\u53EF\u70B9 */
.dsh-tavern-linkBtn{appearance:none;border:0;background:0 0;padding:0;font:inherit;font-size:inherit;line-height:inherit;
  color:var(--dsw-alias-label-secondary, inherit);cursor:pointer;text-decoration:underline;
  text-underline-offset:2px}
.dsh-tavern-linkBtn:hover{color:var(--dsw-alias-label-primary, inherit)}

/* \u7B5B\u9009 chip \u884C */
.dsh-tavern-filters{display:flex;flex-wrap:wrap;gap:8px}
.dsh-tavern-chip{appearance:none;height:28px;padding:0 13px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background:transparent;color:var(--dsw-alias-label-secondary, inherit);font:inherit;font-size:12px;cursor:pointer;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-chip:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))}
.dsh-tavern-chip[data-active="true"]{background:var(--tavern-accent-soft, rgba(65,118,230,.12));
  color:var(--dsw-alias-label-primary, inherit);
  border-color:var(--tavern-accent-border, rgba(65,118,230,.32))}
/* \u591A\u9009 chip\uFF08CheckChips\uFF09\uFF1A\u9009\u4E2D\u65F6\u524D\u7F00\u5BF9\u52FE\uFF0C\u4E0E\u5355\u9009\u7B5B\u9009 chip \u533A\u5206 */
.dsh-tavern-chip.is-check[data-active="true"]:before{content:'\u2713\xA0';font-weight:600;
  color:var(--tavern-accent-strong, #4176e6)}

/* ========== \u89D2\u8272\u6D77\u62A5\u5361\uFF08\u5C01\u9762 + \u5E95\u90E8\u6E10\u53D8\u540D\u6761\uFF09 ========== */
.dsh-tavern-charGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(208px,1fr));gap:16px;margin:0;padding:0;list-style:none}
.dsh-tavern-charCard{position:relative;display:flex;flex-direction:column;border-radius:18px;overflow:hidden;min-width:0;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
  background:var(--dsw-alias-bg-layer-3, transparent);
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-charCard:hover,.dsh-tavern-charCard:focus-visible{
  border-color:var(--tavern-accent-border, rgba(65,118,230,.32));
  transform:translateY(-2px);box-shadow:var(--dsw-shadow-lv2, 0 4px 12px rgba(0,0,0,.04))}
.dsh-tavern-charCard:active{transform:none;box-shadow:none}
/* overflow:hidden \u4F1A\u88C1\u6389\u5168\u5C40 focus \u8F6E\u5ED3\uFF0C\u5185\u7F29\u5230\u5361\u5185 */
.dsh-tavern-charCard:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary, #4176e6);outline-offset:-2px}
.dsh-tavern-charCardCover{position:relative;height:168px;flex:none;overflow:hidden;
  background:linear-gradient(135deg,
    var(--tavern-accent-softer, rgba(65,118,230,.07)),
    var(--dsw-alias-bg-layer-3, rgba(128,128,128,.2)))}
.dsh-tavern-charCardCover>img{width:100%;height:100%;object-fit:cover;display:block;
  transition:transform .3s var(--ds-ease-in-out, ease)}
.dsh-tavern-charCard:hover .dsh-tavern-charCardCover>img,.dsh-tavern-charCard:focus-visible .dsh-tavern-charCardCover>img{transform:scale(1.04)}
.dsh-tavern-charCardInitial{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding-bottom:30px;
  font-size:46px;font-weight:600;color:var(--tavern-accent-strong, #4176e6);user-select:none}
/* \u540D\u6761\u538B\u5728\u5C01\u9762\u5E95\u90E8\u6E10\u53D8\u4E0A\uFF1B\u6E10\u53D8\u540C\u65F6\u538B\u6697\u56FE\u7247\u548C\u6D45\u8272\u515C\u5E95\u5C01\u9762\uFF0C\u660E\u6697\u4E3B\u9898\u4E0B\u767D\u5B57\u90FD\u53EF\u8BFB */
.dsh-tavern-charCardBar{position:absolute;left:0;right:0;bottom:0;padding:32px 14px 12px;min-width:0;
  display:flex;flex-direction:column;gap:2px;
  background:linear-gradient(to top, rgba(15,15,15,.82), rgba(15,15,15,0))}
.dsh-tavern-charCardName{font-size:15px;font-weight:600;line-height:22px;color:#fff;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-charCardMeta{font-size:12px;line-height:17px;color:rgba(255,255,255,.78);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-charCardActions{position:absolute;top:10px;right:10px;display:flex;gap:4px;opacity:0;
  transition:opacity var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-charCard:hover .dsh-tavern-charCardActions,.dsh-tavern-charCard:focus-within .dsh-tavern-charCardActions{opacity:1}
/* \u5C01\u9762\u4E0A\u7684\u64CD\u4F5C\u94AE\uFF1A\u6697\u5E95\u73BB\u7483\u611F\uFF0C\u56FE\u7247\u4E0E\u6D45\u8272\u5C01\u9762\u4E0A\u90FD\u53EF\u8BFB */
.dsh-tavern-coverBtn{width:28px;height:28px;padding:6px;border:none;border-radius:999px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;
  background:rgba(20,20,20,.55);color:#fff;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-coverBtn:hover{background:rgba(20,20,20,.78)}
.dsh-tavern-coverBtn.is-danger:hover{background:var(--dsw-alias-state-error-primary, #ec1313)}
.dsh-tavern-coverBtn:disabled{opacity:.4;cursor:default}

/* ========== \u8D44\u4EA7\u74E6\u7247\uFF08\u4E16\u754C\u4E66 / \u9884\u8BBE / \u4EBA\u8BBE\u7684\u4E00\u884C\u5F0F\u6761\u76EE\uFF09 ========== */
.dsh-tavern-tile{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:16px;min-width:0;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
  background:var(--dsw-alias-bg-layer-3, transparent);
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-tile:hover,.dsh-tavern-tile:focus-visible{
  border-color:var(--tavern-accent-border, rgba(65,118,230,.32));
  transform:translateY(-1px);box-shadow:var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.05))}
.dsh-tavern-tile:active{transform:none;box-shadow:none}
/* \u56FE\u6807\u5EA7\uFF1A\u84DD\u8272 soft \u5E95\uFF0C\u662F\u5217\u8868\u884C\u7684\u8BC6\u522B\u70B9 */
.dsh-tavern-tileIcon{width:42px;height:42px;flex:none;border-radius:12px;
  display:inline-flex;align-items:center;justify-content:center;
  background:var(--tavern-accent-soft, rgba(65,118,230,.12));
  color:var(--tavern-accent-strong, #4176e6)}
.dsh-tavern-tileMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dsh-tavern-tileTitleRow{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-tavern-tileName{min-width:0;font-size:14px;font-weight:500;line-height:21px;
  color:var(--dsw-alias-label-primary, inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-tileSub{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary, inherit);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-tileActions{display:flex;flex:none;align-items:center;gap:4px}

/* ========== \u8F93\u5165\u7C7B ========== */
.dsh-tavern-input{border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
  background:var(--dsw-alias-bg-layer-2, transparent);color:var(--dsw-alias-label-primary, inherit);
  border-radius:10px;padding:4px 10px;font-size:12px;color-scheme:inherit}
.dsh-tavern-textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:96px;padding:10px 12px;
  font-size:13px;line-height:21px;font-family:inherit}
.dsh-tavern-codeFont{font-family:var(--ds-font-family-code, 'SF Mono', Consolas, monospace)}

/* ========== \u4E16\u754C\u4E66\u6761\u76EE accordion ========== */
.dsh-tavern-entry{border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
  background:var(--dsw-alias-bg-layer-3, transparent);border-radius:14px;overflow:hidden;
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    background var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    opacity var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-entry.is-open{background:var(--dsw-alias-bg-layer-2, transparent);
  border-color:var(--dsw-alias-label-dimmed, #888)}
.dsh-tavern-entry.is-off .dsh-tavern-entryTitle{opacity:.55}
.dsh-tavern-entryHead{display:flex;align-items:center;gap:12px;width:100%;padding:13px 16px;border:0;
  background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-entryHead:hover{background:var(--dsw-alias-interactive-bg-hover, transparent)}
.dsh-tavern-entryMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dsh-tavern-entryTitle{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary, inherit);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-entrySub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary, inherit);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-entryBadges{display:flex;flex:none;align-items:center;gap:6px}
.dsh-tavern-chevron{flex:none;color:var(--dsw-alias-label-tertiary, inherit);
  transition:transform var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-chevron.is-open{transform:rotate(180deg)}
.dsh-tavern-entryBody{display:flex;flex-direction:column;gap:12px;padding:2px 16px 16px}
/* \u5C55\u5F00/\u6536\u8D77\u52A8\u753B\u5BB9\u5668\uFF08grid-rows \u624B\u6CD5\uFF0C\u5185\u5BB9\u59CB\u7EC8\u6E32\u67D3\uFF09 */
.dsh-tavern-collapse{display:grid;grid-template-rows:0fr;
  transition:grid-template-rows var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-collapse.is-open{grid-template-rows:1fr}
.dsh-tavern-collapseInner{overflow:hidden;min-height:0}

/* ========== \u8868\u5355 ========== */
.dsh-tavern-field{display:flex;flex-direction:column;gap:7px;min-width:0;margin-bottom:14px}
.dsh-tavern-fieldLabel{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary, inherit)}
/* \u7F16\u8F91\u5668\u5934\u90E8\u7684\u5143\u4FE1\u606F\u884C\uFF1A\u8BF4\u660E\u6587\u5B57 + \u72B6\u6001\u5FBD\u6807\uFF08\u5982\u300C\u672A\u4FDD\u5B58\u300D\uFF09\u5E76\u6392 */
.dsh-tavern-editorMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-tavern-field .dsh-tavern-input,.dsh-tavern-field .dsh-tavern-select,.dsh-tavern-field textarea{
  width:100%;min-width:0;max-width:100%;box-sizing:border-box}
.dsh-tavern-fieldRow{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px 14px}
.dsh-tavern-fieldRow .dsh-tavern-field{margin-bottom:0}
.dsh-tavern-inlineChecks{display:flex;flex-wrap:wrap;gap:10px 18px;font-size:13px;color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-inlineChecks label{display:inline-flex;align-items:center;gap:9px;padding:4px 0;cursor:pointer}
.dsh-tavern-pager{display:flex;align-items:center;justify-content:center;gap:14px;padding:8px 0}
.dsh-tavern-stickyBar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:14px 0 6px;
  border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12))}

/* ========== \u5F39\u7A97 ========== */
.dsh-tavern-modalActions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.dsh-tavern-modal-md{width:min(520px, calc(100vw - 32px));max-width:100%}
.dsh-tavern-modal-lg{width:min(680px, calc(100vw - 32px));max-width:100%}
.dsh-tavern-modal-xl{width:min(880px, calc(100vw - 32px));max-width:100%}
.dsh-tavern-modal-full{width:min(1280px, calc(100vw - 64px));max-width:100%}
/* \u5F39\u7A97\u5185\u7684\u5206\u7EC4\u9762\u677F\u5361\uFF1A\u7ED9\u5BC6\u96C6\u8868\u5355\u4E00\u4E2A\u6709\u547C\u5438\u611F\u7684\u533A\u5757\u7ED3\u6784 */
.dsh-tavern-dialogStack{display:flex;flex-direction:column;gap:16px;min-width:0}
.dsh-tavern-panelCard{display:flex;flex-direction:column;gap:14px;padding:16px 18px;border-radius:16px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
  background:var(--dsw-alias-bg-layer-3, transparent)}
.dsh-tavern-panelCard>.dsh-tavern-groupHead{margin:0}
.dsh-tavern-panelCard .dsh-tavern-field{margin-bottom:0}
.dsh-tavern-panelCard .dsh-tavern-bindingActions{margin-bottom:0}
/* \u5F39\u7A97\u5E95\u90E8\u4E3B\u64CD\u4F5C\u884C\uFF1A\u5371\u9669/\u6B21\u8981\u9760\u5DE6\uFF0C\u4E3B\u64CD\u4F5C\u9760\u53F3\uFF0C\u6491\u6EE1\u5F39\u7A97\u5BBD */
.dsh-tavern-footActions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%}
.dsh-tavern-footSpacer{flex:1}
/* footer \u91CC\u53F3\u4FA7\u6309\u94AE\u5E76\u6210\u4E00\u7EC4\uFF1A\u5F39\u7A97\u5B9E\u9645\u5BBD\u5EA6\u504F\u7A84\u65F6\u6210\u7EC4\u6362\u884C\uFF0C\u4E0D\u7559\u5B64\u513F\u6309\u94AE */
.dsh-tavern-footGroup{display:inline-flex;align-items:center;gap:10px;flex:none}
/* \u4E0A\u4E0B\u6587\u7528\u91CF\u4FE1\u606F\u6761\uFF1A\u5F31\u5E95\u8272\u6761\u5E26\uFF0C\u8FDB\u5EA6\u6761 + \u6587\u5B57 */
.dsh-tavern-usageBar{display:flex;flex-direction:column;gap:6px;padding:12px 16px;border-radius:14px;
  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))}
.dsh-tavern-usageBar .dsh-tavern-meter{margin:0}
/* \u6EDA\u52A8\u533A\u5728 content \u5C42\uFF08Modal \u6307\u5B9A\u7684 scrollable content region\uFF09\uFF0C\u9489\u5728\u89C6\u53E3\u5185\uFF1B
   100vh - 72px = \u89C6\u53E3\u51CF root \u4E0A\u4E0B padding(48) \u4E0E dialog \u5E95\u90E8 padding(24)\u3002
   body \u4E0D\u518D\u5404\u81EA\u9650\u9AD8\uFF0C\u907F\u514D\u5D4C\u5957\u6EDA\u52A8\u3002 */
.dsh-tavern-modalContent{max-height:calc(100vh - 72px);overflow:auto}
/* \u5E26 footer \u7684\u5F39\u7A97\uFF1A\u6EDA\u52A8\u533A\u518D\u8BA9\u51FA footer \u9AD8\u5EA6\uFF08\u7A84\u5BBD\u65F6\u6309\u94AE\u4E24\u884C \u2248116px\uFF09\uFF0C\u5426\u5219\u6574\u4E2A\u5F39\u7A97\u88AB\u9876\u51FA\u89C6\u53E3\u3001footer \u88AB\u88C1 */
.dsh-tavern-modalContent.dsh-tavern-modalHasFooter{max-height:calc(100vh - 188px)}
.dsh-tavern-modalBody{min-width:0}
.dsh-tavern-modalPre{white-space:pre-wrap;font-size:12px;line-height:19px;max-height:60vh;overflow:auto;margin:0}
.dsh-tavern-binding{display:flex;flex-direction:column;gap:16px;min-width:0}
/* \u7ED1\u5B9A\u5F39\u7A97\uFF08full \u6863\uFF09\uFF1A\u5206\u7EC4\u5361\u53CC\u680F\u7F51\u683C\u6392\u5E03\uFF1B\u9519\u8BEF\u6761\u4E0E\u7528\u91CF\u6761\u901A\u680F\uFF0C\u7A84\u89C6\u53E3\u56DE\u843D\u5355\u680F\u3002 */
.dsh-tavern-bindingWide{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
.dsh-tavern-bindingWide>.dsh-tavern-errText,.dsh-tavern-bindingWide>.dsh-tavern-usageBar{grid-column:1/-1}
@media (max-width:860px){.dsh-tavern-bindingWide{grid-template-columns:minmax(0,1fr)}}
.dsh-tavern-bindingActions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}

/* ========== \u6587\u672C\u53CD\u9988 ========== */
.dsh-tavern-errText{color:var(--dsw-alias-state-error-primary, #ec1313);font-size:12px;line-height:18px;margin:6px 0}
.dsh-tavern-muted{color:var(--dsw-alias-label-tertiary, inherit);opacity:.85;font-size:12px;line-height:19px}
.dsh-tavern-notice{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary, inherit);padding:4px 0}
/* \u4E0A\u4E0B\u6587\u7528\u91CF\u7EC6\u8FDB\u5EA6\u6761\uFF1A\u8F68\u9053\u7528\u4E8C\u5C42\u5E95\uFF0C\u586B\u5145\u9ED8\u8BA4 accent\uFF0C\u226590% \u8F6C\u9519\u8BEF\u8272\u63D0\u793A\u63A5\u8FD1\u6253\u6EE1 */
.dsh-tavern-meter{height:4px;border-radius:2px;overflow:hidden;margin:2px 0 6px;
  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))}
.dsh-tavern-meterFill{display:block;height:100%;border-radius:2px;min-width:2px;
  background:var(--tavern-accent, #4176e6);
  transition:width var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-meterFill[data-warn="true"]{background:var(--dsw-alias-state-error-primary, #ec1313)}

/* ========== \u9AA8\u67B6\u5C4F ========== */
.dsh-tavern-skeleton{border-radius:8px;
  background:linear-gradient(90deg,
    var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)) 25%,
    var(--dsw-alias-bg-layer-3, rgba(128,128,128,.2)) 50%,
    var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)) 75%);
  background-size:200% 100%;animation:dsh-tavern-shimmer 1.4s linear infinite}

/* ========== \u8BB0\u5FC6 / \u4E16\u754C\u72B6\u6001\u6761\u76EE ========== */
.dsh-tavern-memo{display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-radius:14px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
  background:var(--dsw-alias-bg-layer-3, transparent);
  transition:border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease)}
.dsh-tavern-memo:hover{border-color:var(--dsw-alias-label-dimmed, #888)}
/* \u5DF2\u64A4\u9500\u7684\u4E16\u754C\u72B6\u6001\u6574\u4F53\u538B\u6697\uFF0C\u53EA\u7559\u53EF\u8BFB\u6027 */
.dsh-tavern-memo.is-revoked{opacity:.62}
/* \u65B0\u589E\u8868\u5355\u5361\uFF1A\u865A\u7EBF\u8FB9\u6846\u793A\u610F\u300C\u5F80\u91CC\u6DFB\u4E1C\u897F\u300D */
.dsh-tavern-memo.is-compose{border-style:dashed;background:transparent}
.dsh-tavern-memo.is-compose:hover{border-color:var(--tavern-accent-border, rgba(65,118,230,.32))}
.dsh-tavern-memoHead{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-tavern-memoMeta{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary, inherit);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-memoBody{margin:0;font-size:13px;line-height:21px;white-space:pre-wrap;word-break:break-word;
  max-height:160px;overflow:auto;color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-memoActions{display:flex;align-items:center;gap:4px}

/* ========== \u804A\u5929\u53D1\u8A00\u6761 ========== */
.dsh-tavern-speech{display:flex;gap:14px;align-items:flex-start;width:100%;min-width:0;position:relative;
  color:var(--dsw-alias-label-primary, inherit)}
/* \u6C14\u6CE1\u53F3\u4E0A\u89D2\u590D\u5236\u94AE\uFF1A\u9ED8\u8BA4\u6536\u8D77\uFF0Chover / \u952E\u76D8\u805A\u7126\u65F6\u6D6E\u73B0 */
.dsh-tavern-speechCopy{position:absolute;top:-2px;right:0;opacity:0;
  transition:opacity var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-speech:hover .dsh-tavern-speechCopy,.dsh-tavern-speech:focus-within .dsh-tavern-speechCopy{opacity:1}
.dsh-tavern-speechAvatar{border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2));box-sizing:border-box}
.dsh-tavern-speechBody{min-width:0;flex:1;display:flex;flex-direction:column;gap:6px}
.dsh-tavern-speechName{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-speechHtml{width:100%;min-height:280px;height:min(72vh,880px);overflow:auto;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));border-radius:18px;
  background:var(--dsw-alias-bg-base, #111);display:block;box-shadow:var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.05))}
.dsh-tavern-speechHtml.is-widget{min-height:0;height:280px;overflow:auto;background:transparent;border:none;box-shadow:none}
.dsh-tavern-reason{margin:0 0 10px;font-size:13px;color:var(--dsw-alias-label-secondary, inherit);min-width:0}
.dsh-tavern-reason>summary{cursor:pointer;user-select:none;list-style:none;padding:5px 0;border-radius:6px;
  transition:color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-reason>summary:hover{color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-reason>summary::-webkit-details-marker{display:none}
.dsh-tavern-reason>summary::before{content:'\u25B8 ';opacity:.7}
.dsh-tavern-reason[open]>summary::before{content:'\u25BE '}
.dsh-tavern-reason pre{white-space:pre-wrap;margin:6px 0 0;font-size:12px;line-height:19px;opacity:.9;
  max-height:40vh;overflow:auto}

/* ========== \u697C\u5C42\u64CD\u4F5C\u6761 ========== */
.dsh-tavern-action{width:28px;height:28px;padding:6px;border:none;border-radius:28px;display:inline-flex;
  align-items:center;justify-content:center;background:0 0;cursor:pointer;
  color:var(--dsw-alias-label-tertiary, inherit);
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-action:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16));
  color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-action:disabled{cursor:default;opacity:.4;background:0 0}
.dsh-tavern-actionGroup{margin-left:auto;display:inline-flex;align-items:center;gap:2px}
/* \u4E2D\u65AD\u697C\u5C42\u7684\u64CD\u4F5C\u7EC4\u6302\u5728\u6D88\u606F\u8282\u70B9\u5185\uFF08\u5BBF\u4E3B\u64CD\u4F5C\u884C\u4E0D\u51FA\u73B0\uFF09\uFF0C\u53D6\u6D88\u9760\u53F3\u3001\u4E0E\u6B63\u6587\u5DE6\u5BF9\u9F50 */
.dsh-tavern-actionGroup-interrupted{margin-left:0;margin-top:4px}
/* \u7EC4\u95F4\u7EC6\u7AD6\u7EBF\uFF1A\u5144\u5F1F\u5BFC\u822A \u2039 n/m \u203A\u3001\u5F00\u573A\u767D swipe\u3001\u697C\u5C42\u64CD\u4F5C\u4E09\u7EC4\u4E4B\u95F4\u7684\u89C6\u89C9\u5206\u754C */
.dsh-tavern-actionDivider{flex:none;width:1px;height:16px;margin:0 8px;
  background:var(--dsw-alias-border-l2, rgba(128,128,128,.25))}
.dsh-tavern-swipeIdx{font-size:12px;line-height:18px;padding:2px 10px;border-radius:999px;text-align:center;
  color:var(--dsw-alias-label-tertiary, inherit);background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))}

/* ========== \u5EA7\u4F4D\u82AF\u7247\uFF08\u4F1A\u8BDD\u5934\u90E8 + \u82F1\u96C4\u533A\u9009\u89D2\uFF09 ========== */
.dsh-tavern-seat{max-width:min(100%,240px);min-height:28px;color:var(--dsw-alias-label-primary, inherit);
  white-space:nowrap;text-overflow:ellipsis;cursor:pointer;background:0 0;border:none;border-radius:16px;
  align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;overflow:hidden;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-seat:not(:disabled):hover,.dsh-tavern-seat[aria-expanded=true]{
  background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))}
.dsh-tavern-seat:disabled{cursor:default;color:var(--dsw-alias-label-dimmed, #888)}
.dsh-tavern-seatIcon{color:var(--dsw-alias-label-primary, inherit);flex:none;display:inline-flex;align-items:center}
.dsh-tavern-seatLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.dsh-tavern-seatChevron{color:var(--dsw-alias-label-caption, #888);flex:none;
  transition:transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-seat[aria-expanded=true] .dsh-tavern-seatChevron{transform:rotate(180deg)}

/* ========== \u82F1\u96C4\u533A\uFF08\u65B0\u4F1A\u8BDD\u9009\u5361 + \u5F00\u573A\u767D\u9884\u89C8\uFF09 ========== */
[data-tavern-hero-seat]{display:inline-flex;flex:none;align-items:center}
.dsh-tavern-hero-preview{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance, 16px) * 2);
  max-width:var(--dsh-chat-content-width, 748px);margin:8px auto 0;padding:16px 18px;border-radius:18px;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
  background:var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, transparent));
  box-shadow:var(--dsw-shadow-lv2, 0 4px 12px rgba(0,0,0,.04));
  color:var(--dsw-alias-label-primary, inherit)}
.dsh-tavern-hero-preview:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary, #4176e6);outline-offset:2px}
.dsh-tavern-hero-previewHead{display:flex;align-items:center;gap:12px;min-width:0}
.dsh-tavern-hero-previewHeadText{min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-tavern-hero-previewName{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary, inherit);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-hero-previewMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption, #888);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tavern-hero-previewText{margin-top:10px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-tertiary, inherit);
  display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
/* \u5F00\u573A\u767D\u6B63\u6587\uFF1A\u5DE6\u4FA7\u84DD\u8272\u5F15\u7528\u7AD6\u7EBF + \u4FDD\u7559\u6362\u884C\uFF0C\u8BFB\u8D77\u6765\u50CF\u89D2\u8272\u5728\u8BF4\u8BDD */
.dsh-tavern-hero-quote{margin-top:12px;padding-left:14px;
  border-left:3px solid var(--tavern-accent-border, rgba(65,118,230,.32));
  font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary, inherit);white-space:pre-wrap;
  display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dsh-tavern-hero-swipe{display:inline-flex;align-items:center;gap:4px;margin-top:8px}
.dsh-tavern-hero-swipeHint{margin-left:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption, #888)}
.dsh-tavern-hero-swipeBtn{width:24px;height:24px;color:var(--dsw-alias-label-tertiary, inherit);cursor:pointer;
  background:0 0;border:none;border-radius:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;
  transition:background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease)}
.dsh-tavern-hero-swipeBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16));
  color:var(--dsw-alias-label-secondary, inherit)}
.dsh-tavern-hero-swipeBtn:disabled{cursor:default;opacity:.4}
.dsh-tavern-hero-swipeIdx{font-size:12px;color:var(--dsw-alias-label-caption, #888);min-width:32px;text-align:center}
.dsh-tavern-hero-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:14px}
.dsh-tavern-hero-actions .dsh-tavern-hero-swipe{margin-left:auto;margin-top:0}
.dsh-tavern-hero-error{color:var(--dsw-alias-state-error-primary, #ec1313);font-size:12px;
  max-width:var(--dsh-chat-content-width, 748px);margin:0 auto 8px;padding:0 var(--dsh-composer-side-clearance, 16px)}
`;
function ensureTavernStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID))
    return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}
ensureTavernStyles();

// lib/client/util.js
function Btn(props) {
  return (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { type: "button", variant: props.primary ? "primary" : "outline", size: props.size ?? "sm", disabled: props.disabled, title: props.title, onClick: (e) => {
    e.stopPropagation();
    props.onClick();
  }, style: props.danger ? { color: "var(--dsw-alias-state-error-primary, #ec1313)" } : void 0, children: props.children });
}
var EMPTY_SELECT_ID = "__empty__";
function Select(props) {
  const [open, setOpen] = (0, import_react2.useState)(false);
  const selected = props.options.find((o) => o.value === props.value);
  const width = props.width ?? "100%";
  return (0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-select", style: { width }, children: (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Menu, { open, portal: true, compact: props.size !== "md", align: "start", selectedId: props.value === "" ? EMPTY_SELECT_ID : props.value, onClose: () => setOpen(false), onSelect: (id) => {
    props.onChange(id === EMPTY_SELECT_ID ? "" : id);
    setOpen(false);
  }, anchor: (0, import_jsx_runtime.jsxs)("button", { type: "button", className: `dsh-tavern-pillSelect${props.size === "sm" ? " is-sm" : ""}`, "aria-haspopup": "menu", "aria-expanded": open, disabled: props.disabled, title: props.title, onClick: () => setOpen((v) => !v), children: [(0, import_jsx_runtime.jsx)("span", { className: "dsh-tavern-pillSelectLabel", children: selected?.label ?? props.value }), (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutline14, { className: "dsh-tavern-pillSelectChevron" })] }), items: props.options.map((o) => ({
    id: o.value === "" ? EMPTY_SELECT_ID : o.value,
    label: o.label
  })) }) });
}
function FileBtn(props) {
  return (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { type: "button", variant: "outline", size: "md", disabled: props.disabled, className: "dsh-tavern-file", onClick: () => {
    const el = document.createElement("input");
    el.type = "file";
    el.accept = props.accept;
    el.onchange = () => {
      const file = el.files?.[0];
      if (file)
        props.onFile(file);
    };
    el.click();
  }, children: props.children });
}
function Section(props) {
  return (0, import_jsx_runtime.jsxs)("section", { className: "dsh-tavern-section", children: [props.title || props.description ? (0, import_jsx_runtime.jsxs)("header", { className: "dsh-tavern-pageHead", children: [props.title ? (0, import_jsx_runtime.jsx)("h3", { className: "dsh-tavern-pageTitle", children: props.title }) : null, props.description ? (0, import_jsx_runtime.jsx)("p", { className: "dsh-tavern-pageIntro", children: props.description }) : null] }) : null, props.children] });
}
function Tabs(props) {
  return (0, import_jsx_runtime.jsx)("div", { className: `dsh-tavern-navPills${props.size === "sm" ? " is-sub" : ""}`, role: "tablist", children: props.items.map((item) => (0, import_jsx_runtime.jsx)("button", { type: "button", role: "tab", className: "dsh-tavern-navPill", "data-active": props.value === item.id ? "true" : "false", "aria-selected": props.value === item.id, onClick: () => props.onChange(item.id), children: item.label }, item.id)) });
}
function SaveBar(props) {
  return (0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-saveBar", children: props.children });
}
function Badge(props) {
  const cls = props.accent ? " is-accent" : props.danger ? " is-danger" : "";
  return (0, import_jsx_runtime.jsx)("span", { className: `dsh-tavern-badge${cls}`, children: props.children });
}
function RegexScriptRow(props) {
  const { script } = props;
  const t2 = useT();
  const badges = [];
  if (script.markdownOnly && script.promptOnly)
    badges.push(t2("util.regexScope.displayAndPrompt"));
  else if (script.markdownOnly)
    badges.push(t2("util.regexScope.displayOnly"));
  else if (script.promptOnly)
    badges.push(t2("util.regexScope.promptOnly"));
  else {
    for (const p of script.placement ?? [2]) {
      if (p === 1)
        badges.push(t2("util.regexScope.userInput"));
      else if (p === 2)
        badges.push(t2("util.regexScope.aiOutput"));
      else if (p === 5)
        badges.push(t2("util.regexScope.worldInfo"));
    }
  }
  const find = script.findRegex ?? "";
  const enabled = script.disabled !== true;
  return (0, import_jsx_runtime.jsxs)("div", { className: "dsh-tavern-memo", children: [(0, import_jsx_runtime.jsxs)("div", { className: "dsh-tavern-memoHead", children: [props.onToggle ? (0, import_jsx_runtime.jsx)(Toggle, { checked: enabled, disabled: props.disabled, onChange: (on) => props.onToggle(!on), title: enabled ? t2("util.regex.disable") : t2("util.regex.enable") }) : null, (0, import_jsx_runtime.jsx)("span", { className: "dsh-tavern-memoMeta", style: { color: "var(--dsw-alias-label-primary, inherit)", fontWeight: 500 }, children: script.scriptName?.trim() || t2("util.regex.unnamed", { index: props.index + 1 }) }), badges.map((label) => (0, import_jsx_runtime.jsx)(Badge, { children: label }, label))] }), (0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-codeFont", title: find, style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: find || t2("util.regex.noFind") })] });
}
function Toggle(props) {
  return (0, import_jsx_runtime.jsx)("button", { type: "button", role: "switch", "aria-checked": props.checked, className: `dsh-tavern-toggle${props.checked ? " is-on" : ""}`, disabled: props.disabled, title: props.title, onClick: (e) => {
    e.stopPropagation();
    props.onChange(!props.checked);
  } });
}
function IconBtn(props) {
  return (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: props.label, side: "bottom", children: (0, import_jsx_runtime.jsx)("button", { type: "button", "aria-label": props.label, className: `dsh-tavern-iconBtn${props.danger ? " is-danger" : ""}`, disabled: props.disabled, onClick: (e) => {
    e.stopPropagation();
    props.onClick();
  }, children: props.children }) });
}
function SettingsRow(props) {
  return (0, import_jsx_runtime.jsxs)("div", { className: `dsh-tavern-row${props.stacked ? " is-stacked" : ""}`, children: [(0, import_jsx_runtime.jsxs)("div", { className: "dsh-tavern-rowText", children: [(0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-rowTitle", children: props.title }), props.description ? (0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-rowDesc", children: props.description }) : null] }), (0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-rowControl", children: props.children })] });
}
function Field(props) {
  return (0, import_jsx_runtime.jsxs)("div", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime.jsx)("span", { className: "dsh-tavern-fieldLabel", children: props.label }), props.children] });
}
function SearchInput(props) {
  const t2 = useT();
  return (0, import_jsx_runtime.jsxs)("div", { className: "dsh-tavern-search", role: "search", style: { width: props.width ?? 220 }, children: [(0, import_jsx_runtime.jsx)("span", { className: "dsh-tavern-searchIcon", children: (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconSearchOutline16, {}) }), (0, import_jsx_runtime.jsx)("input", { type: "text", "aria-label": props.label, placeholder: props.placeholder ?? t2("common.searchPlaceholder"), value: props.value, onChange: (e) => props.onChange(e.target.value) })] });
}
function SearchEmpty(props) {
  const t2 = useT();
  return (0, import_jsx_runtime.jsxs)("div", { className: "dsh-tavern-empty", children: [(0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-emptyTitle", children: t2("common.noMatch", { what: props.what }) }), (0, import_jsx_runtime.jsxs)("div", { className: "dsh-tavern-emptyDesc", children: [t2("common.noMatchDesc", { query: props.query }), (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-tavern-linkBtn", onClick: props.onClear, children: t2("action.clearSearch") })] })] });
}
function CheckChips(props) {
  return (0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-filters", role: "group", "aria-label": props.ariaLabel, children: props.options.map((o) => {
    const on = props.selected.includes(o.value);
    return (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-tavern-chip is-check", "data-active": on ? "true" : "false", "aria-pressed": on, onClick: () => props.onChange(on ? props.selected.filter((v) => v !== o.value) : [...props.selected, o.value]), children: o.label }, o.value);
  }) });
}
function Err(props) {
  if (!props.message)
    return null;
  return (0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-errText", children: props.message });
}
function Muted(props) {
  return (0, import_jsx_runtime.jsx)("span", { className: "dsh-tavern-muted", children: props.children });
}
function Avatar(props) {
  const size = props.size ?? 40;
  const style = { "--tavern-avatar-s": `${size}px` };
  const cls = `dsh-tavern-avatar${props.className ? ` ${props.className}` : ""}`;
  if (props.url) {
    return (0, import_jsx_runtime.jsx)("span", { className: cls, style, children: (0, import_jsx_runtime.jsx)("img", { src: props.url, alt: "" }) });
  }
  const initial = (props.name ?? "").trim().charAt(0);
  if (initial && size >= 24) {
    return (0, import_jsx_runtime.jsx)("span", { className: cls, style, children: initial });
  }
  return (0, import_jsx_runtime.jsx)("span", { className: cls, style, children: (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconUserOutline16, { size: Math.max(12, Math.round(size * 0.6)) }) });
}
function Skeleton(props) {
  return (0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-skeleton", style: { width: props.width ?? "100%", height: props.height ?? 14, borderRadius: props.radius, ...props.style } });
}
function useToast() {
  const [item, setItem] = (0, import_react2.useState)(null);
  const show = (0, import_react2.useCallback)((text) => setItem({ key: Date.now(), text }), []);
  const node = item ? (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Toast, { text: item.text, onDone: () => setItem(null) }, item.key) : null;
  return { show, node };
}
function clickableProps(onClick) {
  return {
    role: "button",
    tabIndex: 0,
    onClick,
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    }
  };
}
function useLoader(load, deps = [], enabled = true, timeoutMs = 2e4) {
  const t2 = useT();
  const [state, setState] = (0, import_react2.useState)(enabled ? { status: "loading" } : { status: "idle" });
  const [seq, setSeq] = (0, import_react2.useState)(0);
  (0, import_react2.useEffect)(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    let alive = true;
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      if (alive)
        setState({ status: "error", message: t2("util.loadTimeout") });
    }, timeoutMs);
    const settle = () => clearTimeout(timer);
    load().then((r) => {
      settle();
      if (alive)
        setState(r.ok ? { status: "ready", value: r.value } : { status: "error", message: r.error.message });
    }).catch((e) => {
      settle();
      if (alive)
        setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [...deps, seq, enabled]);
  return { state, reload: () => setSeq((s) => s + 1) };
}
function errOf(r) {
  return r.ok ? null : r.error.message;
}
async function runAsync(setBusy, setError, fn, onError) {
  setBusy(true);
  setError(null);
  try {
    await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (onError)
      onError(message);
    else
      setError(message);
  } finally {
    setBusy(false);
  }
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function readJsonFile(file) {
  return JSON.parse(await file.text());
}
function downloadJson(filename, json) {
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
function downloadBase64(filename, base642, mime) {
  const binary = atob(base642);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
function Dialog(props) {
  const t2 = useT();
  const widthClass = props.width === "md" ? "dsh-tavern-modal-md" : props.width === "lg" ? "dsh-tavern-modal-lg" : props.width === "xl" ? "dsh-tavern-modal-xl" : props.width === "full" ? "dsh-tavern-modal-full" : "";
  return (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Modal, { open: props.open, onClose: props.onClose, title: props.title, description: props.description, closeLabel: t2("action.close"), footer: props.footer, className: widthClass || void 0, contentClassName: `dsh-tavern-modalContent${props.footer ? " dsh-tavern-modalHasFooter" : ""}`, children: (0, import_jsx_runtime.jsx)("div", { className: "dsh-tavern-ui dsh-tavern-modalBody", children: props.children }) });
}
function ConfirmDialog(props) {
  const t2 = useT();
  return (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Modal, { open: props.open, onClose: props.onCancel, title: props.title, description: props.description, closeLabel: t2("action.cancel"), footer: (0, import_jsx_runtime.jsxs)("div", { className: "dsh-tavern-modalActions", children: [(0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { type: "button", variant: "outline", size: "md", disabled: props.busy, onClick: props.onCancel, children: t2("action.cancel") }), (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { type: "button", variant: "primary", size: "md", disabled: props.busy, onClick: props.onConfirm, style: props.danger ? { background: "var(--dsw-alias-state-error-primary, #ec1313)", borderColor: "transparent" } : void 0, children: props.confirmLabel ?? t2("action.confirm") })] }) });
}
function NumInput(props) {
  return (0, import_jsx_runtime.jsx)("input", { type: "number", className: "dsh-tavern-input", style: { width: props.width ?? 90 }, value: Number.isFinite(props.value) ? props.value : 0, step: props.step ?? "any", onChange: (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v))
      props.onChange(v);
  } });
}
function NullableNumInput(props) {
  const t2 = useT();
  return (0, import_jsx_runtime.jsx)("input", { type: "number", className: "dsh-tavern-input", style: { width: props.width ?? 90 }, value: props.value ?? "", placeholder: t2("common.unlimited"), onChange: (e) => {
    const raw = e.target.value;
    if (raw === "")
      return props.onChange(null);
    const v = Number(raw);
    if (Number.isFinite(v))
      props.onChange(v);
  } });
}

// lib/client/actions.js
function IconAction(props) {
  return (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Tooltip, { label: props.label, side: "bottom", children: (0, import_jsx_runtime2.jsx)("button", { type: "button", "aria-label": props.label, className: "dsh-tavern-action", disabled: props.disabled, onClick: props.onClick, children: props.busy ? (0, import_jsx_runtime2.jsx)("span", { className: "dsh-tavern-spin", children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconLoadingOutline16, {}) }) : props.children }) });
}
var BINDING_CHANGED_EVENT = "dsh-tavern:binding-changed";
var BRANCH_CHANGED_EVENT = "dsh-tavern:branch-changed";
function useTavernBound(remote, sessionId, enabled) {
  const [bound, setBound] = (0, import_react3.useState)(null);
  (0, import_react3.useEffect)(() => {
    if (!enabled) {
      setBound(false);
      return;
    }
    let alive = true;
    const load = () => cachedSessionBinding(remote, sessionId).then((r) => {
      if (alive)
        setBound(r.ok ? r.value.binding !== null : null);
    }).catch(() => {
      if (alive)
        setBound(null);
    });
    void load();
    const onChanged = (e) => {
      if (e.detail === sessionId)
        void load();
    };
    window.addEventListener(BINDING_CHANGED_EVENT, onChanged);
    return () => {
      alive = false;
      window.removeEventListener(BINDING_CHANGED_EVENT, onChanged);
    };
  }, [remote, sessionId, enabled]);
  return bound;
}
function TavernFloorActions(props) {
  const { remote, sessionId, sessions, messageId } = props;
  const t2 = useT();
  const tavern = isTavernSession(props.useSessions, sessionId);
  const bound = useTavernBound(remote, sessionId, tavern);
  const [operation, setOperation] = (0, import_react3.useState)(null);
  const [failure, setFailure] = (0, import_react3.useState)(null);
  const [editFailure, setEditFailure] = (0, import_react3.useState)(null);
  const [edit, setEdit] = (0, import_react3.useState)(null);
  const [editAiFailure, setEditAiFailure] = (0, import_react3.useState)(null);
  const [editAi, setEditAi] = (0, import_react3.useState)(null);
  const [impersonated, setImpersonated] = (0, import_react3.useState)(null);
  const toast = useToast();
  const swipeLoader = useLoader(() => remote.getGreetingSwipe({ sessionId, messageId }), [sessionId, messageId], bound === true && Boolean(messageId));
  const siblingLoader = useLoader(() => remote.getFloorSiblings({ sessionId, messageId }), [sessionId, messageId], bound === true && Boolean(messageId));
  (0, import_react3.useEffect)(() => {
    if (bound !== true || !messageId)
      return;
    const onChanged = (event) => {
      if (event.detail === sessionId)
        swipeLoader.reload();
    };
    const onBranchChanged = (event) => {
      if (event.detail === sessionId)
        siblingLoader.reload();
    };
    window.addEventListener(BINDING_CHANGED_EVENT, onChanged);
    window.addEventListener(BRANCH_CHANGED_EVENT, onBranchChanged);
    return () => {
      window.removeEventListener(BINDING_CHANGED_EVENT, onChanged);
      window.removeEventListener(BRANCH_CHANGED_EVENT, onBranchChanged);
    };
  }, [bound, messageId, sessionId]);
  const greetState = swipeLoader.state.status === "ready" ? swipeLoader.state.value : null;
  const swipe = greetState?.swipe ?? null;
  const isGreeting = greetState?.isGreeting === true;
  const started = greetState?.started === true;
  const siblingSwipe = siblingLoader.state.status === "ready" ? siblingLoader.state.value.swipe : null;
  const run = async (kind, op) => {
    setOperation(kind);
    setFailure(null);
    try {
      const r = await op();
      if (r.ok) {
        window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
        await openChildSession(sessions, r.value.childSessionId, r.value.title);
      } else
        setFailure(r.error.message);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setOperation(null);
    }
  };
  if (!tavern || bound !== true || !messageId)
    return null;
  const busy = operation !== null;
  const onRegenerate = () => void run("regenerate", () => remote.regenerate({ sessionId, messageId }));
  const onRollback = () => void run("rollback", () => remote.rollbackToFloor({ sessionId, messageId }));
  const onSwipe = (delta) => {
    if (!swipe || busy)
      return;
    const next = ((swipe.index + delta) % swipe.total + swipe.total) % swipe.total;
    void run(delta < 0 ? "swipe-prev" : "swipe-next", () => remote.swipeGreeting({ sessionId, index: next }));
  };
  const onBranch = (delta) => {
    const nav = siblingSwipe;
    if (!nav || nav.total < 2 || busy)
      return;
    const target = nav.siblings[(nav.index + delta + nav.total) % nav.total];
    if (!target || target === sessionId)
      return;
    setOperation(delta < 0 ? "branch-prev" : "branch-next");
    void openChildSession(sessions, target).catch(() => {
      toast.show(t2("actions.branchGone"));
      siblingLoader.reload();
    }).finally(() => setOperation(null));
  };
  const onEdit = async () => {
    setOperation("load-edit");
    setFailure(null);
    setEditFailure(null);
    try {
      const r = await remote.getFloorUserMessage({ sessionId, messageId });
      if (r.ok)
        setEdit({ turn: r.value.turn, text: r.value.text });
      else
        setFailure(r.error.message);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setOperation(null);
    }
  };
  const submitEdit = async () => {
    const draft = edit;
    if (!draft)
      return;
    setOperation("submit-edit");
    setEditFailure(null);
    try {
      const r = await remote.editUserMessage({ sessionId, messageId, text: draft.text });
      if (r.ok) {
        setEdit(null);
        window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
        await openChildSession(sessions, r.value.childSessionId, r.value.title);
      } else {
        setEditFailure(r.error.message);
      }
    } catch (e) {
      setEditFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setOperation(null);
    }
  };
  const onContinue = async () => {
    setOperation("continue");
    setFailure(null);
    try {
      const r = await remote.continueFloor({ sessionId, messageId });
      if (!r.ok)
        setFailure(r.error.message);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setOperation(null);
    }
  };
  const onEditAi = async () => {
    setOperation("load-edit-ai");
    setFailure(null);
    setEditAiFailure(null);
    try {
      const r = await remote.getFloorAssistantMessage({ sessionId, messageId });
      if (r.ok)
        setEditAi({ turn: r.value.turn, text: r.value.text });
      else
        setFailure(r.error.message);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setOperation(null);
    }
  };
  const submitEditAi = async () => {
    const draft = editAi;
    if (!draft)
      return;
    setOperation("submit-edit-ai");
    setEditAiFailure(null);
    try {
      const r = await remote.editAssistantMessage({ sessionId, messageId, text: draft.text });
      if (r.ok) {
        setEditAi(null);
        window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
        await openChildSession(sessions, r.value.childSessionId, r.value.title);
      } else {
        setEditAiFailure(r.error.message);
      }
    } catch (e) {
      setEditAiFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setOperation(null);
    }
  };
  const onImpersonate = async () => {
    setOperation("impersonate");
    setFailure(null);
    try {
      const r = await remote.impersonate({ sessionId });
      if (!r.ok) {
        setFailure(r.error.message);
        return;
      }
      try {
        await navigator.clipboard.writeText(r.value.text);
        toast.show(t2("actions.impersonateCopied"));
      } catch {
        setImpersonated(r.value.text);
      }
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setOperation(null);
    }
  };
  return (0, import_jsx_runtime2.jsxs)("span", { className: "dsh-tavern-actionGroup", children: [!isGreeting && siblingSwipe && siblingSwipe.total > 1 && (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [(0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.branchPrev"), disabled: busy, busy: operation === "branch-prev", onClick: () => onBranch(-1), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconChevronLeftOutline14, {}) }), (0, import_jsx_runtime2.jsxs)("span", { className: "dsh-tavern-swipeIdx", title: t2("actions.branchCount", { turn: siblingSwipe.turn, total: siblingSwipe.total }), children: [siblingSwipe.index + 1, "/", siblingSwipe.total] }), (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.branchNext"), disabled: busy, busy: operation === "branch-next", onClick: () => onBranch(1), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconChevronRightOutline14, {}) }), (0, import_jsx_runtime2.jsx)("span", { className: "dsh-tavern-actionDivider" })] }), swipe && (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [(0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.swipePrev"), disabled: busy, busy: operation === "swipe-prev", onClick: () => onSwipe(-1), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconChevronLeftOutline14, {}) }), (0, import_jsx_runtime2.jsxs)("span", { className: "dsh-tavern-swipeIdx", children: [swipe.index + 1, "/", swipe.total] }), (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.swipeNext"), disabled: busy, busy: operation === "swipe-next", onClick: () => onSwipe(1), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconChevronRightOutline14, {}) }), (0, import_jsx_runtime2.jsx)("span", { className: "dsh-tavern-actionDivider" })] }), !isGreeting && (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.regenerate"), disabled: busy, busy: operation === "regenerate", onClick: onRegenerate, children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconRefreshOutline16, {}) }), !isGreeting && (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.continue"), disabled: busy, busy: operation === "continue", onClick: () => void onContinue(), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconPlayOutline16, {}) }), !isGreeting && (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.editUser"), disabled: busy, busy: operation === "load-edit", onClick: () => void onEdit(), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconEditOutline16, {}) }), !isGreeting && (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.editAi"), disabled: busy, busy: operation === "load-edit-ai", onClick: () => void onEditAi(), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconListPenOutline16, {}) }), (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.impersonate"), disabled: busy, busy: operation === "impersonate", onClick: () => void onImpersonate(), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconUserOutline16, {}) }), (!isGreeting || started) && (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.rollback"), disabled: busy, busy: operation === "rollback", onClick: onRollback, children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconBranchOutline16, {}) }), failure !== null && (0, import_jsx_runtime2.jsx)("span", { role: "status", style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #ec1313)", paddingLeft: 4 }, children: failure }), edit !== null && (0, import_jsx_runtime2.jsxs)(Dialog, { open: true, title: t2("actions.editUserTitle", { turn: edit.turn }), onClose: () => {
    if (!busy)
      setEdit(null);
  }, children: [(0, import_jsx_runtime2.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 120 }, value: edit.text, onChange: (e) => setEdit({ ...edit, text: e.target.value }) }), (0, import_jsx_runtime2.jsx)(Err, { message: editFailure }), (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-tavern-modalActions", style: { marginTop: 12 }, children: [(0, import_jsx_runtime2.jsx)(Btn, { disabled: busy, onClick: () => setEdit(null), children: t2("action.cancel") }), (0, import_jsx_runtime2.jsx)(Btn, { disabled: busy || !edit.text.trim(), onClick: () => void submitEdit(), children: operation === "submit-edit" ? t2("actions.saving") : t2("actions.saveRerun") })] })] }), editAi !== null && (0, import_jsx_runtime2.jsxs)(Dialog, { open: true, title: t2("actions.editAiTitle", { turn: editAi.turn }), onClose: () => {
    if (!busy)
      setEditAi(null);
  }, children: [(0, import_jsx_runtime2.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 160 }, value: editAi.text, onChange: (e) => setEditAi({ ...editAi, text: e.target.value }) }), (0, import_jsx_runtime2.jsx)(Err, { message: editAiFailure }), (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-tavern-modalActions", style: { marginTop: 12 }, children: [(0, import_jsx_runtime2.jsx)(Btn, { disabled: busy, onClick: () => setEditAi(null), children: t2("action.cancel") }), (0, import_jsx_runtime2.jsx)(Btn, { disabled: busy || !editAi.text.trim(), onClick: () => void submitEditAi(), children: operation === "submit-edit-ai" ? t2("actions.saving") : t2("actions.saveNoRerun") })] })] }), impersonated !== null && (0, import_jsx_runtime2.jsxs)(Dialog, { open: true, title: t2("actions.impersonateTitle"), onClose: () => setImpersonated(null), children: [(0, import_jsx_runtime2.jsx)("textarea", { readOnly: true, className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 120 }, value: impersonated }), (0, import_jsx_runtime2.jsx)("div", { style: { marginTop: 8, fontSize: 12, opacity: 0.8 }, children: t2("actions.clipboardUnavailable") })] }), toast.node] });
}
function TavernInterruptedFloorActions(props) {
  const { remote, sessionId, sessions, turn } = props;
  const t2 = useT();
  const toast = useToast();
  const [operation, setOperation] = (0, import_react3.useState)(null);
  const [failure, setFailure] = (0, import_react3.useState)(null);
  const siblingLoader = useLoader(() => remote.getFloorSiblings({ sessionId, turn }), [sessionId, turn]);
  (0, import_react3.useEffect)(() => {
    const onBranchChanged = (event) => {
      if (event.detail === sessionId)
        siblingLoader.reload();
    };
    window.addEventListener(BRANCH_CHANGED_EVENT, onBranchChanged);
    return () => window.removeEventListener(BRANCH_CHANGED_EVENT, onBranchChanged);
  }, [sessionId]);
  const siblingSwipe = siblingLoader.state.status === "ready" ? siblingLoader.state.value.swipe : null;
  const busy = operation !== null;
  const run = async (kind, op) => {
    setOperation(kind);
    setFailure(null);
    try {
      const r = await op();
      if (r.ok) {
        window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
        await openChildSession(sessions, r.value.childSessionId, r.value.title);
      } else
        setFailure(r.error.message);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setOperation(null);
    }
  };
  const onBranch = (delta) => {
    const nav = siblingSwipe;
    if (!nav || nav.total < 2 || busy)
      return;
    const target = nav.siblings[(nav.index + delta + nav.total) % nav.total];
    if (!target || target === sessionId)
      return;
    setOperation(delta < 0 ? "branch-prev" : "branch-next");
    void openChildSession(sessions, target).catch(() => {
      toast.show(t2("actions.branchGone"));
      siblingLoader.reload();
    }).finally(() => setOperation(null));
  };
  return (0, import_jsx_runtime2.jsxs)("span", { className: "dsh-tavern-actionGroup dsh-tavern-actionGroup-interrupted", children: [siblingSwipe && siblingSwipe.total > 1 && (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [(0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.branchPrev"), disabled: busy, busy: operation === "branch-prev", onClick: () => onBranch(-1), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconChevronLeftOutline14, {}) }), (0, import_jsx_runtime2.jsxs)("span", { className: "dsh-tavern-swipeIdx", title: t2("actions.branchCount", { turn: siblingSwipe.turn, total: siblingSwipe.total }), children: [siblingSwipe.index + 1, "/", siblingSwipe.total] }), (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.branchNext"), disabled: busy, busy: operation === "branch-next", onClick: () => onBranch(1), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconChevronRightOutline14, {}) }), (0, import_jsx_runtime2.jsx)("span", { className: "dsh-tavern-actionDivider" })] }), (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.regenerate"), disabled: busy, busy: operation === "regenerate", onClick: () => void run("regenerate", () => remote.regenerate({ sessionId, turn })), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconRefreshOutline16, {}) }), (0, import_jsx_runtime2.jsx)(IconAction, { label: t2("actions.rollback"), disabled: busy, busy: operation === "rollback", onClick: () => void run("rollback", () => remote.rollbackToFloor({ sessionId, turn })), children: (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconBranchOutline16, {}) }), failure !== null && (0, import_jsx_runtime2.jsx)("span", { role: "status", style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #ec1313)", paddingLeft: 4 }, children: failure }), toast.node] });
}

// lib/client/assistant.js
var import_jsx_runtime4 = require("react/jsx-runtime");
var import_react5 = require("react");
var import_dsh_client_ui_primitives4 = require("@deepseek-ai/dsh-client-ui-primitives");

// lib/core/macros.js
var IDENTITY_MACRO_RE = /\{\{\s*(char|charname|user|username)\s*\}\}/gi;
function expandIdentityMacros(text, ctx) {
  if (!text.includes("{{"))
    return text;
  return text.replace(IDENTITY_MACRO_RE, (_raw, name2) => {
    const k = name2.toLowerCase();
    return k === "user" || k === "username" ? ctx.user : ctx.char;
  });
}

// lib/core/dshPrompt.js
var UNBOUND_STANDING = [
  "Tavern \u6A21\u5F0F\u5DF2\u5F00\u542F\uFF0C\u4F46\u5F53\u524D\u4F1A\u8BDD\u5C1A\u672A\u7ED1\u5B9A\u89D2\u8272\u5361\u3002",
  "\u8BF7\u4EE5\u666E\u901A\u52A9\u624B\u8EAB\u4EFD\u7B80\u77ED\u56DE\u5E94\uFF1B\u4E0D\u8981\u8C03\u7528 tavern_* \u5DE5\u5177\u3002",
  "\u7528\u6237\u9700\u8981\u5728\u5BF9\u8BDD\u9875\u9009\u62E9\u89D2\u8272\u5361\u540E\uFF0C\u624D\u80FD\u5F00\u59CB\u89D2\u8272\u626E\u6F14\u3002"
].join("\n");
var BOUND_DISCIPLINE = [
  "\u4F60\u6B63\u5728\u8FDB\u884C\u89D2\u8272\u626E\u6F14\u3002\u4E0B\u9762\u662F\u672C\u4F1A\u8BDD\u7A33\u5B9A\u7684\u89D2\u8272\u5B9A\u4E49\u4E0E\u63D0\u793A\u8BCD\u9AA8\u67B6\u3002",
  "\u672C\u8F6E\u89E6\u53D1\u7684\u4E16\u754C\u4E66\u3001\u68C0\u7D22\u8BB0\u5FC6\u4E0E\u4E16\u754C\u72B6\u6001\u5728 runtime context \u4E2D\uFF0C\u4F1A\u8986\u76D6\u66F4\u65E9\u7684\u540C\u540D\u5FEB\u7167\uFF1B\u4E0D\u8981\u628A\u672A\u51FA\u73B0\u7684\u6761\u76EE\u5F53\u6210\u4E8B\u5B9E\u3002",
  "\u9ED8\u8BA4\u76F4\u63A5\u4EE5\u89D2\u8272\u8EAB\u4EFD\u56DE\u590D\u3002\u53EA\u5728\u7F3A\u8BBE\u5B9A\u3001\u6216\u8981\u628A\u672C\u8F6E\u5DF2\u786E\u5B9A\u7684\u4E8B\u5B9E\u5199\u5165\u957F\u671F\u8BB0\u5FC6/\u4E16\u754C\u72B6\u6001\u65F6\uFF0C\u624D\u4F7F\u7528 tavern_* \u5DE5\u5177\u3002",
  "\u53EA\u5728\u672C\u8F6E\u6700\u540E\u4E00\u6B65\u8F93\u51FA\u626E\u6F14\u6B63\u6587\uFF1B\u4E2D\u95F4\u6B65\u9AA4\u4E0D\u8981\u5BF9\u7528\u6237\u8BF4\u8BDD\u3002\u8BB0\u5FC6\u53EA\u8BB0\u4E8B\u5B9E\u3001\u5173\u952E\u4E8B\u4EF6\u4E0E\u5173\u7CFB/\u72B6\u6001\u53D8\u5316\uFF0C\u7981\u6B62\u6D41\u6C34\u8D26\u3002",
  "\u5DE5\u5177\u5199\u5165\u7684\u68C0\u7D22\u5C42\u4ECE\u4E0B\u4E00\u8F6E\u66F4\u65B0\uFF1B\u540C\u8F6E\u4F1A\u6536\u5230\u5199\u5165\u786E\u8BA4\u3002\u5199\u5B8C\u540E\u4ECD\u987B\u5728\u672C\u8F6E\u8F93\u51FA\u626E\u6F14\u6B63\u6587\u3002"
].join("\n");
var TURN_PLAYBOOK = [
  "\u3010\u672C\u8F6E\u3011runtime context \u5DF2\u542B\u89E6\u53D1\u7684\u4E16\u754C\u4E66\u3001\u68C0\u7D22\u8BB0\u5FC6\u4E0E\u4E16\u754C\u72B6\u6001\uFF1B\u540C\u8F6E\u540E\u7EED\u6B65\u9AA4\u4E0D\u91CD\u590D\u8FFD\u52A0\uFF0C\u4E0A\u65B9\u5FEB\u7167\u5373\u4E3A\u672C\u8F6E\u6700\u65B0\u3002",
  "\u5FEB\u7167\u5185\u7684\u8BBE\u5B9A\u591F\u7528\u5C31\u76F4\u63A5\u4EE5\u89D2\u8272\u8EAB\u4EFD\u56DE\u590D\uFF0C\u4E0D\u8981\u4E3A\u4E86\u518D\u786E\u8BA4\u800C\u8C03\u7528\u5DE5\u5177\u3002",
  "\u56DE\u590D\u82E5\u6D89\u53CA\u4EBA\u7269\u5173\u7CFB\u3001\u5730\u70B9\u3001\u89C4\u5219\u3001\u65E2\u6709\u4E8B\u4EF6\u7B49\u8BBE\u5B9A\uFF0C\u800C\u5FEB\u7167\u672A\u8986\u76D6\u6216\u4F60\u4E0D\u786E\u5B9A\uFF1A\u5148\u7528 tavern_lore_read\uFF08\u5148\u76EE\u5F55\uFF0C\u518D uid/\u5173\u952E\u8BCD\u53D6\u6761\uFF09/ tavern_memory_search / tavern_asset_read \u6309\u6761\u67E5\u8BC1\u518D\u52A8\u7B14\uFF0C\u4E0D\u8981\u51ED\u5370\u8C61\u7F16\u9020\u3002",
  "\u957F\u5BF9\u8BDD\u82E5\u8BBE\u5B9A\u88AB\u51B2\u6389\uFF0C\u540C\u6837\u6309\u6761\u8865\u8BFB\uFF0C\u4E0D\u8981\u6574\u672C\u503E\u5012\u3002",
  "\u672C\u8F6E\u786E\u5B9A\u53D1\u751F\u7684\u4E8B\u5B9E\u624D\u5199\u5165\u8BB0\u5FC6\u6216\u4E16\u754C\u72B6\u6001\uFF1B\u5199\u5165\u4ECE\u4E0B\u4E00\u8F6E\u624D\u6CE8\u5165\u68C0\u7D22\u5C42\uFF0C\u540C\u8F6E\u4F1A\u6536\u5230\u5199\u5165\u786E\u8BA4\u3002",
  "\u4E2D\u95F4\u6B65\u9AA4\u4E0D\u8981\u5BF9\u7528\u6237\u8BF4\u8BDD\uFF1B\u9700\u8981\u6536\u53E3\u65F6\u4F1A\u6536\u5230\u3010Tavern \u6B65\u9AA4\u3011\u901A\u77E5\uFF0C\u7167\u505A\u5373\u53EF\u3002"
].join("\n");

// lib/core/displaySanitize.js
var DISPLAY_META_TAGS = [
  "UpdateVariable",
  "JSONPatch",
  "Analysis",
  "think",
  "thinking",
  "StatusPlaceHolderImpl"
];
var PROTOCOL_TAG_RE = /<\/?(?:[A-Za-z][\w]*_[A-Za-z0-9_]+|[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b[^>]*\/?>/g;
function isCoverHtml(text) {
  return /<!DOCTYPE\s+html/i.test(text) || /<html[\s>]/i.test(text) || /<body[\s>]/i.test(text);
}
function stripClosedAndEmpty(text) {
  let out = text;
  for (let pass = 0; pass < 8; pass++) {
    let next = out;
    for (const tag of DISPLAY_META_TAGS) {
      next = next.replace(new RegExp(`<${tag}\\b[^>]*/>`, "gi"), "");
      next = next.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi"), "");
    }
    next = next.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    next = next.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, "");
    if (next === out)
      break;
    out = next;
  }
  return out;
}
function stripUnclosedMeta(text) {
  let cut = -1;
  for (const tag of DISPLAY_META_TAGS) {
    const re = new RegExp(`<${tag}\\b`, "gi");
    const match = re.exec(text);
    if (match && (cut < 0 || match.index < cut))
      cut = match.index;
  }
  return cut >= 0 ? text.slice(0, cut) : text;
}
function stripWidgetTail(text) {
  const markers = [
    /<div\b[^>]*\bstream-log\b/i,
    /<details\b[^>]*\b[\w-]*-box\b/i,
    /<div\b[^>]*\b[\w-]*-box\b/i,
    /<style\b/i
  ];
  let cut = -1;
  for (const re of markers) {
    const match = re.exec(text);
    if (match && (cut < 0 || match.index < cut))
      cut = match.index;
  }
  return cut >= 0 ? text.slice(0, cut) : text;
}
function tidy(text) {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function stripProtocolTags(text) {
  return text.replace(PROTOCOL_TAG_RE, "");
}
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}
function stripDisplayMeta(text) {
  if (!text)
    return text;
  if (isCoverHtml(text))
    return text;
  return tidy(stripProtocolTags(stripWidgetTail(stripUnclosedMeta(stripClosedAndEmpty(stripHtmlComments(text))))));
}

// lib/client/speech.js
var import_jsx_runtime3 = require("react/jsx-runtime");
var import_react4 = require("react");
var import_dsh_client_ui_primitives3 = require("@deepseek-ai/dsh-client-ui-primitives");

// lib/core/cardFrame.js
var CARD_BRIDGE_SOURCE = "dsh-tavern-card";
function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
var CSP_HOST_RE = /^(?:https?:\/\/)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;
function cspContent(connectHosts) {
  const raw = connectHosts.map((h) => h.trim()).filter((h) => h === "*" || CSP_HOST_RE.test(h));
  const allowAll = raw.includes("*");
  const hosts = raw.filter((h) => h !== "*").map((h) => h.includes("://") ? h : `https://${h}`);
  const connect = allowAll ? "https: http:" : hosts.length > 0 ? hosts.join(" ") : "'none'";
  const script = allowAll ? "'unsafe-inline' https: http:" : ["'unsafe-inline'", ...hosts].join(" ");
  return [
    "default-src 'none'",
    `script-src ${script}`,
    "style-src 'unsafe-inline' https:",
    "img-src https: http: data: blob:",
    "font-src https: http: data:",
    "media-src https: http: data: blob:",
    `connect-src ${connect}`
  ].join("; ");
}
function tavernCardBridgeScript(options) {
  const payload = escapeScriptJson({
    greetings: options.greetings,
    greetingIndex: options.greetingIndex,
    source: CARD_BRIDGE_SOURCE
  });
  return `<script data-dsh-tavern-bridge>
(function () {
  // \u6C99\u7BB1\u65E0 allow-same-origin\uFF08opaque origin\uFF09\uFF1A\u8BBF\u95EE localStorage/sessionStorage \u4F1A\u629B
  // SecurityError\u3002\u4F9D\u8D56\u5B58\u50A8\u7684\u5C01\u9762\u811A\u672C\u5728\u542F\u52A8\u65F6\u5C31\u4F1A\u6574\u9875\u5D29\u6210\u7A7A\u767D\u3002
  // \u88C5\u5185\u5B58\u7248 shim\u2014\u2014\u6302\u5728 window \u4E0A\uFF0Cdocument.write \u91CD\u5199\u6587\u6863\u540E\u4F9D\u7136\u751F\u6548\uFF1B\u5237\u65B0\u5373\u5931\uFF0C\u4E0D\u843D\u76D8\u3002
  function memStorage() {
    var map = {};
    return {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[String(k)] = String(v); },
      removeItem: function (k) { delete map[String(k)]; },
      clear: function () { map = {}; },
      key: function (i) { var ks = Object.keys(map); return i >= 0 && i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(map).length; }
    };
  }
  function shimStorage(name) {
    try {
      var nativeStore = window[name];
      nativeStore.getItem('__dsh_tavern_probe__');
    } catch (e) {
      try {
        Object.defineProperty(window, name, { configurable: true, enumerable: true, value: memStorage() });
      } catch (e2) {}
    }
  }
  shimStorage('localStorage');
  shimStorage('sessionStorage');
  var cfg = ${payload};
  function post(action, extra) {
    var msg = { source: cfg.source, action: action };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
    try { parent.postMessage(msg, '*'); } catch (e) {}
  }
  function msgAt(i) {
    var g = cfg.greetings || [];
    var idx = typeof i === 'number' ? i : cfg.greetingIndex;
    if (idx < 0) idx = 0;
    if (g.length && idx >= g.length) idx = idx % g.length;
    var mes = g[idx] != null ? g[idx] : (g[0] || '');
    return {
      message: mes,
      mes: mes,
      name: '',
      is_user: false,
      is_system: false,
      swipe_id: idx,
      swipes: g.slice(),
      extra: {},
      send_date: Date.now()
    };
  }
  async function getChatMessages(range) {
    void range;
    return [msgAt(cfg.greetingIndex)];
  }
  async function setChatMessage(field, messageId, options) {
    void field;
    void messageId;
    var opts = options || {};
    var index = typeof opts.swipe_id === 'number' ? opts.swipe_id : cfg.greetingIndex;
    post('swipeGreeting', { index: index });
  }
  async function triggerSlash(text) {
    var t = String(text || '');
    if (/^\\/swipe\\b/i.test(t)) post('swipeGreeting', { index: cfg.greetingIndex + 1 });
    return t;
  }
  var chat = [msgAt(cfg.greetingIndex)];
  function saveChat() {
    var swipe = chat[0] && typeof chat[0].swipe_id === 'number' ? chat[0].swipe_id : cfg.greetingIndex;
    post('swipeGreeting', { index: swipe });
    return Promise.resolve();
  }
  var ctx = {
    chat: chat,
    swipe: function () { post('swipeGreeting', { index: cfg.greetingIndex + 1 }); },
    saveChat: saveChat
  };
  var api = { getChatMessages: getChatMessages, setChatMessage: setChatMessage, triggerSlash: triggerSlash };
  window.getChatMessages = getChatMessages;
  window.setChatMessage = setChatMessage;
  window.triggerSlash = triggerSlash;
  window.toastr = window.toastr || { info: function () {}, success: function () {}, warning: function () {}, error: function () {} };
  window.SillyTavern = { getContext: function () { return ctx; } };
  window.TavernHelper = Object.assign(window.TavernHelper || {}, api);
  function reportHeight() {
    try {
      var h = 0;
      var el = document.documentElement;
      var body = document.body;
      if (el) h = Math.max(h, el.scrollHeight || 0, el.offsetHeight || 0);
      if (body) {
        h = Math.max(h, body.scrollHeight || 0, body.offsetHeight || 0);
        var nodes = body.querySelectorAll('*');
        var n = Math.min(nodes.length, 400);
        for (var i = 0; i < n; i++) {
          var r = nodes[i].getBoundingClientRect();
          if (r && r.bottom > h) h = r.bottom;
        }
      }
      if (h > 0) post('resize', { height: Math.ceil(h) });
    } catch (e) {}
  }
  function watchHeight() {
    reportHeight();
    if (typeof ResizeObserver !== 'undefined') {
      try {
        var ro = new ResizeObserver(function () { reportHeight(); });
        if (document.documentElement) ro.observe(document.documentElement);
        if (document.body) ro.observe(document.body);
      } catch (e2) {}
    }
    window.addEventListener('load', reportHeight);
    setTimeout(reportHeight, 300);
    setTimeout(reportHeight, 1200);
  }
  // \u5C01\u9762\u5E38 document.write \u6574\u9875 HTML\uFF0C\u4F1A\u51B2\u6389 head \u91CC\u7684\u6865\u3002\u628A stub/CSP \u5199\u56DE\u540E\u518D\u843D\u76D8\u3002
  var origOpen = document.open.bind(document);
  var origWrite = document.write.bind(document);
  var origClose = document.close.bind(document);
  var writeBuf = null;
  var stubNode = document.currentScript;
  var stubHtml = stubNode && stubNode.outerHTML ? stubNode.outerHTML : '';
  var cspNode = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  var cspHtml = cspNode && cspNode.outerHTML ? cspNode.outerHTML : '';
  function injectBridge(html) {
    if (!html) return html;
    if (stubHtml && html.indexOf('data-dsh-tavern-bridge') < 0) {
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, function (m) { return m + cspHtml + stubHtml; });
      else html = '<head>' + cspHtml + stubHtml + '</head>' + html;
    }
    return html;
  }
  document.open = function () {
    writeBuf = '';
    return document;
  };
  document.write = function () {
    var chunk = Array.prototype.join.call(arguments, '');
    if (writeBuf === null) {
      if (/<!DOCTYPE/i.test(chunk) || /<html[\\s>]/i.test(chunk)) {
        writeBuf = chunk;
        return;
      }
      return origWrite(chunk);
    }
    writeBuf += chunk;
  };
  document.writeln = function () {
    document.write(Array.prototype.join.call(arguments, '') + '\\n');
  };
  document.close = function () {
    if (writeBuf === null) return origClose();
    var html = injectBridge(writeBuf);
    writeBuf = null;
    origOpen();
    origWrite(html);
    origClose();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchHeight);
  else watchHeight();
})();
<\/script>`;
}
function injectHead(html, headInner) {
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + headInner + html.slice(at);
  }
  return `<head>${headInner}</head>${html}`;
}
function ensureHtmlDocument(html) {
  if (/<html[\s>]/i.test(html))
    return html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}
function buildCardSrcDoc(html, options) {
  const meta2 = `<meta http-equiv="Content-Security-Policy" content="${cspContent(options.connectHosts ?? [])}">`;
  const stub = tavernCardBridgeScript(options);
  return injectHead(ensureHtmlDocument(html), meta2 + stub);
}
function parseCardBridgeMessage(data) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    return null;
  const rec = data;
  if (rec.source !== CARD_BRIDGE_SOURCE || typeof rec.action !== "string")
    return null;
  const index = typeof rec.index === "number" && Number.isFinite(rec.index) ? rec.index : void 0;
  const height = typeof rec.height === "number" && Number.isFinite(rec.height) ? rec.height : void 0;
  return {
    source: rec.source,
    action: rec.action,
    ...index !== void 0 ? { index } : {},
    ...height !== void 0 ? { height } : {}
  };
}

// lib/client/speech.js
function SpeechHtmlFrame(props) {
  const iframeRef = (0, import_react4.useRef)(null);
  const [frameH, setFrameH] = (0, import_react4.useState)(null);
  (0, import_react4.useEffect)(() => {
    setFrameH(null);
  }, [props.srcDoc]);
  (0, import_react4.useEffect)(() => {
    const onMsg = (e) => {
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow)
        return;
      const parsed = parseCardBridgeMessage(e.data);
      if (!parsed)
        return;
      if (parsed.action === "swipeGreeting" && typeof parsed.index === "number") {
        props.onSwipeGreeting?.(parsed.index);
      }
      if (parsed.action === "resize" && typeof parsed.height === "number" && Number.isFinite(parsed.height)) {
        setFrameH(Math.min(8e3, Math.max(80, Math.ceil(parsed.height))));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [props.onSwipeGreeting]);
  const frameStyle = frameH != null ? { height: frameH, minHeight: 0, overflow: "hidden" } : props.widget ? { height: 280, minHeight: 0, overflow: "auto" } : { overflow: "auto" };
  return (0, import_jsx_runtime3.jsx)("iframe", { ref: iframeRef, className: `dsh-tavern-speechHtml${props.widget ? " is-widget" : ""}`, sandbox: "allow-scripts", srcDoc: props.srcDoc, title: props.title, style: frameStyle });
}
function SpeechBubble(props) {
  const { remote, sessionId, cardId, name: name2, rawText, streaming, onSwipeGreeting } = props;
  const t2 = useT();
  const markdownLabels = useMarkdownLabels();
  const avatar = useLoader(() => cachedAvatar(remote, cardId), [cardId], Boolean(cardId));
  const rendered = useLoader(() => remote.renderOutputText({ sessionId, text: rawText }), [sessionId, rawText], Boolean(rawText) && !streaming);
  const avatarUrl = avatar.state.status === "ready" ? avatar.state.value.dataUrl : null;
  const interactive = props.interactiveCards ?? (rendered.state.status === "ready" ? rendered.state.value.interactiveCards : true);
  const htmls = !streaming && interactive && rendered.state.status === "ready" ? rendered.state.value.htmls && rendered.state.value.htmls.length > 0 ? rendered.state.value.htmls : rendered.state.value.html ? [rendered.state.value.html] : [] : [];
  const text = !streaming && rendered.state.status === "ready" ? interactive || rendered.state.value.text ? rendered.state.value.text : stripDisplayMeta(rawText) : stripDisplayMeta(rawText);
  const whitelist = rendered.state.status === "ready" ? rendered.state.value.whitelist : [];
  const greetings = rendered.state.status === "ready" ? rendered.state.value.greetings ?? [] : [];
  const greetingIndex = rendered.state.status === "ready" ? rendered.state.value.greetingIndex ?? 0 : 0;
  const canSwipe = rendered.state.status === "ready" ? rendered.state.value.canSwipeGreeting !== false : false;
  const toast = useToast();
  const onCopy = async () => {
    const plain = text || stripDisplayMeta(rawText);
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = plain;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        toast.show(ok ? t2("speech.copied") : t2("speech.copyFailed"));
      } catch {
        toast.show(t2("speech.copyFailed"));
      }
    };
    try {
      await navigator.clipboard.writeText(plain);
      toast.show(t2("speech.copied"));
    } catch {
      fallback();
    }
  };
  const frames = htmls.map((html, i) => {
    const srcDoc = buildCardSrcDoc(html, { greetings, greetingIndex, connectHosts: whitelist });
    const widget = htmls.length > 1 ? i > 0 : Boolean(text);
    return (0, import_jsx_runtime3.jsx)(SpeechHtmlFrame, { srcDoc, title: name2, widget, onSwipeGreeting: canSwipe ? onSwipeGreeting : void 0 }, `${i}:${html.length}`);
  });
  return (0, import_jsx_runtime3.jsxs)("div", { className: "dsh-tavern-speech dsh-tavern-rise", children: [(0, import_jsx_runtime3.jsx)(Avatar, { url: avatarUrl, name: name2, size: 40, className: "dsh-tavern-speechAvatar" }), (0, import_jsx_runtime3.jsxs)("div", { className: "dsh-tavern-speechBody", children: [(0, import_jsx_runtime3.jsx)("div", { className: "dsh-tavern-speechName", children: name2 }), frames, (frames.length === 0 || text) && (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives3.MarkdownText, { text: text || " ", streaming: Boolean(streaming), labels: markdownLabels })] }), (0, import_jsx_runtime3.jsx)("div", { className: "dsh-tavern-speechCopy", children: (0, import_jsx_runtime3.jsx)(IconBtn, { label: t2("speech.copy"), onClick: () => void onCopy(), children: (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives3.IconCopyOutline16, {}) }) }), toast.node] });
}

// lib/client/assistant.js
function ReasoningFold(props) {
  const t2 = useT();
  if (!props.text.trim())
    return null;
  return (0, import_jsx_runtime4.jsxs)("details", { className: "dsh-tavern-reason", children: [(0, import_jsx_runtime4.jsx)("summary", { children: props.streaming ? t2("assistant.thinking") : t2("assistant.thought") }), (0, import_jsx_runtime4.jsx)("pre", { children: props.text })] });
}
function TavernAssistantNode(props) {
  const { remote, sessionId, sessions, node } = props;
  const t2 = useT();
  const tavern = isTavernSession(props.useSessions, sessionId);
  const bindingLoader = useLoader(() => cachedSessionBinding(remote, sessionId), [sessionId], tavern);
  const binding = bindingLoader.state.status === "ready" ? bindingLoader.state.value.binding : null;
  const detail = useLoader(() => cachedCharacterDetail(remote, binding.cardId), [binding?.cardId], tavern && binding !== null);
  const streaming = node.data.status === "running";
  const interrupted = node.data.status === "interrupted";
  const text = node.data.blocks.filter((b) => b.kind === "text").map((b) => b.text ?? "").join("\n");
  const name2 = detail.state.status === "ready" ? detail.state.value.name : "";
  const hasImages = node.data.blocks.some((b) => b.kind === "image");
  const reasoningBlocks = node.data.blocks.filter((b) => b.kind === "reasoning");
  const reasoningText = reasoningBlocks.map((b) => b.text ?? "").filter((chunk) => chunk.trim()).join("\n\n---\n\n");
  if (!tavern) {
    return (0, import_jsx_runtime4.jsx)(NativeAssistantFallback, { ...props, streaming, interrupted });
  }
  const locationTurn = node.location && (node.location.kind === "turn" || node.location.kind === "step") ? node.location.turn?.turn : void 0;
  const interruptedActions = interrupted && binding && typeof locationTurn === "number" && sessions ? (0, import_jsx_runtime4.jsx)(TavernInterruptedFloorActions, { remote, sessionId, sessions, turn: locationTurn }) : null;
  if (binding && text && !hasImages) {
    return (0, import_jsx_runtime4.jsxs)("div", { children: [(0, import_jsx_runtime4.jsx)(ReasoningFold, { text: reasoningText, streaming }), (0, import_jsx_runtime4.jsx)(SpeechBubble, { remote, sessionId, cardId: binding.cardId, name: name2 || t2("assistant.characterFallback"), rawText: text, streaming, interactiveCards: binding.interactiveCards, onSwipeGreeting: (index) => {
      if (!sessions)
        return;
      void remote.swipeGreeting({ sessionId, index }).then((r) => {
        if (r.ok)
          return openChildSession(sessions, r.value.childSessionId, r.value.title);
      }).catch(() => {
      });
    } }), interrupted && (0, import_jsx_runtime4.jsx)("div", { className: "dsh-tavern-notice", children: t2("assistant.stopped") }), interruptedActions] });
  }
  return (0, import_jsx_runtime4.jsxs)("div", { children: [(0, import_jsx_runtime4.jsx)(NativeAssistantFallback, { ...props, streaming, interrupted, stripMeta: true }), interruptedActions] });
}
function NativeAssistantFallback(props) {
  const { node, renderMessageImages, useTurnData, openFile, fileMentions, streaming, interrupted, stripMeta } = props;
  const t2 = useT();
  const markdownLabels = useMarkdownLabels();
  const turn = node.location?.kind === "turn" || node.location?.kind === "step" ? node.location.turn : void 0;
  const tail = useTurnData?.("turn-tail");
  const finalSeq = node.data.finalNode?.seq;
  const mentionOwner = (0, import_react5.useMemo)(() => {
    if (!turn || turn.status !== "closed" || finalSeq === void 0)
      return void 0;
    if (tail?.closing?.finalNode?.seq !== finalSeq)
      return void 0;
    return { turn, seq: finalSeq, openFile };
  }, [turn, tail, finalSeq, openFile]);
  const mentions = (0, import_react5.useMemo)(() => mentionOwner && fileMentions ? fileMentions(mentionOwner) : void 0, [fileMentions, mentionOwner]);
  const rendered = [];
  const blocks = node.data.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block)
      continue;
    if (block.kind === "text") {
      const shown = stripMeta ? stripDisplayMeta(block.text ?? "") : block.text ?? "";
      rendered.push((0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives4.MarkdownText, { text: shown, streaming, fileMentions: mentions, labels: markdownLabels }, i));
    } else if (block.kind === "reasoning") {
      if (stripMeta)
        continue;
      rendered.push((0, import_jsx_runtime4.jsxs)("details", { className: "dsh-tavern-reason", children: [(0, import_jsx_runtime4.jsx)("summary", { children: streaming ? t2("assistant.thinking") : t2("assistant.thought") }), (0, import_jsx_runtime4.jsx)("pre", { children: block.text })] }, i));
    } else if (block.kind === "image") {
      const group = [block];
      while (i + 1 < blocks.length) {
        const next = blocks[i + 1];
        if (!next || next.kind !== "image")
          break;
        group.push(next);
        i += 1;
      }
      if (renderMessageImages) {
        rendered.push((0, import_jsx_runtime4.jsx)(import_react5.Fragment, { children: renderMessageImages({ images: group.map(({ attachment }) => ({ attachment })), align: "start" }) }, i));
      }
    } else if (block.kind === "tool-call") {
      continue;
    } else {
      rendered.push((0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives4.JsonBlock, { label: t2("assistant.unknownBlock"), truncatedLabel: (total) => t2("assistant.truncated", { total }), payload: block.block }, i));
    }
  }
  return (0, import_jsx_runtime4.jsxs)("div", { children: [stripMeta ? (0, import_jsx_runtime4.jsx)(ReasoningFold, { text: node.data.blocks.filter((b) => b.kind === "reasoning").map((b) => b.text ?? "").join("\n\n"), streaming }) : null, rendered, interrupted ? (0, import_jsx_runtime4.jsx)("span", { children: t2("assistant.stopped") }) : null] });
}

// lib/client/chip.js
var import_jsx_runtime7 = require("react/jsx-runtime");
var import_react7 = require("react");

// lib/client/seatChip.js
var import_jsx_runtime5 = require("react/jsx-runtime");
var import_dsh_client_ui_primitives5 = require("@deepseek-ai/dsh-client-ui-primitives");
function TavernSeatChip(props) {
  return (0, import_jsx_runtime5.jsxs)("button", { type: "button", className: "dsh-tavern-seat", "aria-haspopup": props.hasPopup ?? "menu", "aria-expanded": props.open, title: props.title ?? props.label, disabled: props.disabled || props.loading, onClick: props.onClick, children: [props.loading ? (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [(0, import_jsx_runtime5.jsx)("span", { className: "dsh-tavern-seatIcon", children: (0, import_jsx_runtime5.jsx)(Skeleton, { width: 16, height: 16, radius: 999 }) }), (0, import_jsx_runtime5.jsx)("span", { className: "dsh-tavern-seatLabel", children: (0, import_jsx_runtime5.jsx)(Skeleton, { width: 64, height: 13 }) })] }) : (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [props.avatarUrl ? (0, import_jsx_runtime5.jsx)("span", { className: "dsh-tavern-seatIcon", children: (0, import_jsx_runtime5.jsx)(Avatar, { url: props.avatarUrl, name: props.label, size: 16 }) }) : null, (0, import_jsx_runtime5.jsx)("span", { className: "dsh-tavern-seatLabel", children: props.label })] }), props.chevron !== false ? (0, import_jsx_runtime5.jsx)(import_dsh_client_ui_primitives5.IconChevronDownOutline14, { className: "dsh-tavern-seatChevron" }) : null, props.trailing] });
}

// lib/core/worldbook.js
var MAX_WI_KEY_CHARS = 500;

// lib/state/lorebook.js
var MAX_LOREBOOK_ENTRIES = 2e3;
var MAX_LOREBOOK_CONTENT_CHARS = 1e5;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toStr(value) {
  if (typeof value === "string")
    return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}
function toStrArr(value) {
  if (!Array.isArray(value))
    return [];
  return value.map(toStr).filter((s) => s !== "");
}
function toNum(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n))
      return n;
  }
  return fallback;
}
function toNumOrNull(value) {
  if (value === null || value === void 0)
    return null;
  if (typeof value === "boolean")
    return value ? 1 : null;
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n))
      return n;
  }
  return null;
}
function toBool(value, fallback) {
  if (typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return value !== 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "1")
      return true;
    if (s === "false" || s === "0" || s === "")
      return false;
  }
  if (value === null || value === void 0)
    return fallback;
  return Boolean(value);
}
function toBoolOrNull(value) {
  if (value === null || value === void 0)
    return null;
  return toBool(value, false);
}
function toPosition(value, fallback = 0) {
  const n = toNum(value, Number.NaN);
  return Number.isInteger(n) && n >= 0 && n <= 7 ? n : fallback;
}
function toRole(value) {
  const n = toNum(value, Number.NaN);
  return n === 0 || n === 1 || n === 2 ? n : 0;
}
function toSelectiveLogic(value) {
  const n = toNum(value, Number.NaN);
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : 0;
}
function toDelayUntilRecursion(value) {
  if (typeof value === "boolean")
    return value ? 1 : 0;
  return toNum(value, 0);
}
function makeKey(uid, opts) {
  return `${opts.source}:${opts.sourceRef}:${uid}`;
}
function parseNativeEntry(raw, uid, opts) {
  return {
    key: makeKey(uid, opts),
    uid,
    source: opts.source,
    sourceRef: opts.sourceRef,
    keys: toStrArr(raw.key),
    secondaryKeys: toStrArr(raw.keysecondary),
    selective: toBool(raw.selective, true),
    selectiveLogic: toSelectiveLogic(raw.selectiveLogic),
    comment: toStr(raw.comment),
    content: toStr(raw.content),
    constant: toBool(raw.constant, false),
    enabled: !toBool(raw.disable, false),
    order: toNum(raw.order, 100),
    position: toPosition(raw.position),
    depth: toNum(raw.depth, 4),
    role: toRole(raw.role),
    outletName: toStr(raw.outletName),
    probability: toNum(raw.probability, 100),
    useProbability: toBool(raw.useProbability, true),
    caseSensitive: toBoolOrNull(raw.caseSensitive),
    matchWholeWords: toBoolOrNull(raw.matchWholeWords),
    scanDepth: toNumOrNull(raw.scanDepth),
    excludeRecursion: toBool(raw.excludeRecursion, false),
    preventRecursion: toBool(raw.preventRecursion, false),
    delayUntilRecursion: toDelayUntilRecursion(raw.delayUntilRecursion),
    sticky: toNumOrNull(raw.sticky),
    cooldown: toNumOrNull(raw.cooldown),
    delay: toNumOrNull(raw.delay),
    ignoreBudget: toBool(raw.ignoreBudget, false),
    group: toStr(raw.group),
    groupWeight: toNum(raw.groupWeight, 100),
    groupOverride: toBool(raw.groupOverride, false),
    automationId: toStr(raw.automationId)
  };
}
function parseBookPosition(raw, ext) {
  const fromExt = toNum(ext.position, Number.NaN);
  if (Number.isInteger(fromExt) && fromExt >= 0 && fromExt <= 7)
    return fromExt;
  if (raw.position === "before_char")
    return 0;
  if (raw.position === "after_char")
    return 1;
  return toPosition(raw.position);
}
function parseCharacterBookEntry(raw, uid, opts) {
  const ext = isRecord(raw.extensions) ? raw.extensions : {};
  return {
    key: makeKey(uid, opts),
    uid,
    source: opts.source,
    sourceRef: opts.sourceRef,
    keys: toStrArr(raw.keys),
    secondaryKeys: toStrArr(raw.secondary_keys),
    selective: toBool(raw.selective, false),
    selectiveLogic: toSelectiveLogic(ext.selectiveLogic),
    comment: toStr(raw.comment),
    content: toStr(raw.content),
    constant: toBool(raw.constant, false),
    enabled: toBool(raw.enabled, true),
    order: toNum(raw.insertion_order, 100),
    position: parseBookPosition(raw, ext),
    depth: toNum(ext.depth, 4),
    role: toRole(ext.role),
    outletName: toStr(ext.outlet_name),
    probability: toNum(ext.probability, 100),
    useProbability: toBool(ext.useProbability, true),
    caseSensitive: toBoolOrNull(ext.case_sensitive !== void 0 ? ext.case_sensitive : raw.case_sensitive),
    matchWholeWords: toBoolOrNull(ext.match_whole_words),
    scanDepth: toNumOrNull(ext.scan_depth),
    excludeRecursion: toBool(ext.exclude_recursion, false),
    preventRecursion: toBool(ext.prevent_recursion, false),
    delayUntilRecursion: toDelayUntilRecursion(ext.delay_until_recursion),
    sticky: toNumOrNull(ext.sticky),
    cooldown: toNumOrNull(ext.cooldown),
    delay: toNumOrNull(ext.delay),
    ignoreBudget: toBool(ext.ignore_budget, false),
    group: toStr(ext.group),
    groupWeight: toNum(ext.group_weight !== void 0 ? ext.group_weight : ext.groupWeight, 100),
    groupOverride: toBool(ext.group_override !== void 0 ? ext.group_override : ext.groupOverride, false),
    automationId: toStr(ext.automation_id)
  };
}
function isCharacterBookEntry(raw) {
  return Array.isArray(raw.keys) || isRecord(raw.extensions) || "insertion_order" in raw || "secondary_keys" in raw || typeof raw.position === "string";
}
function parseEntry(raw, uid, opts) {
  const entry = isCharacterBookEntry(raw) ? parseCharacterBookEntry(raw, uid, opts) : parseNativeEntry(raw, uid, opts);
  assertEntryWithinLimits(raw, entry);
  return entry;
}
function assertEntryWithinLimits(raw, entry) {
  for (const field of ["key", "keys", "keysecondary", "secondary_keys"]) {
    const value = raw[field];
    if (value !== void 0 && value !== null && !Array.isArray(value)) {
      throw new Error(`\u4E16\u754C\u4E66\u6761\u76EE ${entry.uid} \u7684 ${field} \u4E0D\u662F\u6570\u7EC4\uFF0C\u62D2\u7EDD\u5BFC\u5165`);
    }
  }
  const content = raw.content;
  if (content !== void 0 && content !== null && typeof content === "object") {
    throw new Error(`\u4E16\u754C\u4E66\u6761\u76EE ${entry.uid} \u7684 content \u4E0D\u662F\u5B57\u7B26\u4E32\uFF0C\u62D2\u7EDD\u5BFC\u5165`);
  }
  for (const key of [...entry.keys, ...entry.secondaryKeys]) {
    if (key.length > MAX_WI_KEY_CHARS) {
      throw new Error(`\u4E16\u754C\u4E66\u6761\u76EE ${entry.uid} \u7684\u89E6\u53D1\u952E\u8D85\u8FC7 ${MAX_WI_KEY_CHARS} \u5B57\u7B26\u4E0A\u9650\uFF0C\u62D2\u7EDD\u5BFC\u5165`);
    }
  }
  if (entry.content.length > MAX_LOREBOOK_CONTENT_CHARS) {
    throw new Error(`\u4E16\u754C\u4E66\u6761\u76EE ${entry.uid} \u7684\u6B63\u6587\u8D85\u8FC7 ${MAX_LOREBOOK_CONTENT_CHARS} \u5B57\u7B26\u4E0A\u9650\uFF0C\u62D2\u7EDD\u5BFC\u5165`);
  }
}
function entryUid(raw, fallback) {
  return toStr(raw.uid ?? raw.id) || fallback;
}
function parseEntryArray(entries, opts) {
  if (entries.length > MAX_LOREBOOK_ENTRIES) {
    throw new Error(`\u4E16\u754C\u4E66\u6761\u76EE\u6570 ${entries.length} \u8D85\u8FC7\u4E0A\u9650 ${MAX_LOREBOOK_ENTRIES}\uFF0C\u62D2\u7EDD\u5BFC\u5165`);
  }
  const out = [];
  entries.forEach((value, index) => {
    if (!isRecord(value))
      return;
    out.push(parseEntry(value, entryUid(value, String(index)), opts));
  });
  return out;
}
function parseLorebook(json, opts) {
  if (Array.isArray(json))
    return parseEntryArray(json, opts);
  if (!isRecord(json))
    throw new Error("\u4E16\u754C\u4E66 JSON \u4E0D\u662F\u5BF9\u8C61\u6216\u6761\u76EE\u6570\u7EC4");
  const rawEntries = json.entries;
  if (Array.isArray(rawEntries))
    return parseEntryArray(rawEntries, opts);
  if (isRecord(rawEntries)) {
    const pairs = Object.entries(rawEntries);
    if (pairs.length > MAX_LOREBOOK_ENTRIES) {
      throw new Error(`\u4E16\u754C\u4E66\u6761\u76EE\u6570 ${pairs.length} \u8D85\u8FC7\u4E0A\u9650 ${MAX_LOREBOOK_ENTRIES}\uFF0C\u62D2\u7EDD\u5BFC\u5165`);
    }
    const out = [];
    for (const [mapKey, value] of pairs) {
      if (!isRecord(value))
        continue;
      out.push(parseEntry(value, mapKey, opts));
    }
    return out;
  }
  throw new Error("\u4E16\u754C\u4E66 JSON \u7F3A\u5C11 entries\uFF08\u5BF9\u8C61 map \u6216\u6570\u7EC4\uFF09");
}
function exportLorebook(entries, name2) {
  void name2;
  const map = {};
  for (const e of entries) {
    map[e.uid] = {
      uid: e.uid,
      key: e.keys,
      keysecondary: e.secondaryKeys,
      comment: e.comment,
      content: e.content,
      constant: e.constant,
      disable: !e.enabled,
      order: e.order,
      position: e.position,
      depth: e.depth,
      role: e.role,
      outletName: e.outletName,
      probability: e.probability,
      useProbability: e.useProbability,
      selective: e.selective,
      selectiveLogic: e.selectiveLogic,
      scanDepth: e.scanDepth,
      caseSensitive: e.caseSensitive,
      matchWholeWords: e.matchWholeWords,
      excludeRecursion: e.excludeRecursion,
      preventRecursion: e.preventRecursion,
      delayUntilRecursion: e.delayUntilRecursion,
      sticky: e.sticky,
      cooldown: e.cooldown,
      delay: e.delay,
      ignoreBudget: e.ignoreBudget,
      group: e.group,
      groupWeight: e.groupWeight,
      groupOverride: e.groupOverride,
      automationId: e.automationId
    };
  }
  return { entries: map };
}

// lib/client/panel/lorebookEditor.js
var import_jsx_runtime6 = require("react/jsx-runtime");
var import_react6 = require("react");
var import_dsh_client_ui_primitives6 = require("@deepseek-ai/dsh-client-ui-primitives");
var PAGE_SIZE = 40;
var positionOptions = (t2) => [
  { value: "0", label: t2("lorebookEditor.position.0") },
  { value: "1", label: t2("lorebookEditor.position.1") },
  { value: "2", label: t2("lorebookEditor.position.2") },
  { value: "3", label: t2("lorebookEditor.position.3") },
  { value: "4", label: t2("lorebookEditor.position.4") },
  { value: "5", label: t2("lorebookEditor.position.5") },
  { value: "6", label: t2("lorebookEditor.position.6") },
  { value: "7", label: t2("lorebookEditor.position.7") }
];
var logicOptions = (t2) => [
  { value: "0", label: t2("lorebookEditor.logic.0") },
  { value: "1", label: t2("lorebookEditor.logic.1") },
  { value: "2", label: t2("lorebookEditor.logic.2") },
  { value: "3", label: t2("lorebookEditor.logic.3") }
];
var ROLE_OPTIONS = [
  { value: "0", label: "system" },
  { value: "1", label: "user" },
  { value: "2", label: "assistant" }
];
var triStateOptions = (t2) => [
  { value: "", label: t2("lorebookEditor.tri.follow") },
  { value: "true", label: t2("lorebookEditor.tri.on") },
  { value: "false", label: t2("lorebookEditor.tri.off") }
];
var triValue = (v) => v === null ? "" : String(v);
var triFrom = (v) => v === "" ? null : v === "true";
function splitKeys(text) {
  return text.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
}
function joinKeys(keys) {
  return keys.join(", ");
}
function entryTitle(t2, entry) {
  const comment = entry.comment.trim();
  if (comment)
    return comment;
  if (entry.keys.length > 0)
    return entry.keys.slice(0, 3).join(", ");
  return t2("lorebookEditor.entry.untitled");
}
function entrySub(t2, entry) {
  const bits = [];
  if (entry.keys.length > 0)
    bits.push(entry.keys.slice(0, 4).join(", "));
  bits.push(t2("lorebookEditor.entry.order", { order: entry.order }));
  if (entry.constant)
    bits.push(t2("lorebookEditor.constant"));
  if (entry.group.trim())
    bits.push(t2("lorebookEditor.entry.group", { group: entry.group.trim() }));
  return bits.join("  \xB7  ");
}
function newUid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function newEntry(source, sourceRef) {
  const uid = newUid();
  return {
    key: `${source}:${sourceRef}:${uid}`,
    uid,
    source,
    sourceRef,
    keys: [],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: 0,
    comment: "",
    content: "",
    constant: false,
    enabled: true,
    order: 100,
    position: 0,
    depth: 4,
    role: 0,
    outletName: "",
    probability: 100,
    useProbability: true,
    caseSensitive: null,
    matchWholeWords: null,
    scanDepth: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    ignoreBudget: false,
    group: "",
    groupWeight: 100,
    groupOverride: false,
    automationId: ""
  };
}
function sourceOf(target) {
  if (target.kind === "library")
    return { source: "global", sourceRef: target.name };
  if (target.kind === "chat")
    return { source: "chat", sourceRef: "chat-lorebook" };
  return { source: "character", sourceRef: target.cardId };
}
function targetKindLabel(t2, kind) {
  if (kind === "character")
    return t2("lorebookEditor.kind.character");
  if (kind === "chat")
    return t2("lorebookEditor.kind.chat");
  return t2("lorebookEditor.kind.library");
}
function LorebookEditor(props) {
  const t2 = useT();
  const { target } = props;
  const { source, sourceRef } = sourceOf(target);
  const [entries, setEntries] = (0, import_react6.useState)(() => props.entries.map((e) => ({ ...e })));
  const [dirty, setDirty] = (0, import_react6.useState)(false);
  const [query, setQuery] = (0, import_react6.useState)("");
  const [filter, setFilter] = (0, import_react6.useState)("all");
  const [page, setPage] = (0, import_react6.useState)(0);
  const [openUid, setOpenUid] = (0, import_react6.useState)(null);
  const [advanced, setAdvanced] = (0, import_react6.useState)(false);
  const [busy, setBusy] = (0, import_react6.useState)(false);
  const [error, setError] = (0, import_react6.useState)(null);
  const [toDelete, setToDelete] = (0, import_react6.useState)(null);
  const [leaveConfirm, setLeaveConfirm] = (0, import_react6.useState)(false);
  const mark = (next) => {
    setEntries(next);
    setDirty(true);
  };
  const patch = (uid, partial2) => {
    mark(entries.map((e) => e.uid === uid ? { ...e, ...partial2 } : e));
  };
  const filtered = (0, import_react6.useMemo)(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter === "on" && !e.enabled)
        return false;
      if (filter === "off" && e.enabled)
        return false;
      if (filter === "constant" && !e.constant)
        return false;
      if (!q)
        return true;
      const hay = `${e.comment}
${e.keys.join(" ")}
${e.secondaryKeys.join(" ")}
${e.content.slice(0, 400)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [entries, filter, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const enabledCount = entries.filter((e) => e.enabled).length;
  const constantCount = entries.filter((e) => e.constant).length;
  const save = () => runAsync(setBusy, setError, async () => {
    const json = target.kind === "character" ? { name: target.name, ...exportLorebook(entries, target.name) } : exportLorebook(entries, target.name);
    const r = await props.save(json);
    const err = errOf(r);
    if (err)
      setError(err);
    else {
      setDirty(false);
      props.onSaved();
    }
  });
  const addEntry = () => {
    const created = newEntry(source, sourceRef);
    mark([created, ...entries]);
    setFilter("all");
    setQuery("");
    setPage(0);
    setOpenUid(created.uid);
    setAdvanced(false);
  };
  const applyFilterEnabled = (enabled) => {
    const ids = new Set(filtered.map((e) => e.uid));
    mark(entries.map((e) => ids.has(e.uid) ? { ...e, enabled } : e));
  };
  const removeEntry = () => {
    if (!toDelete)
      return;
    mark(entries.filter((e) => e.uid !== toDelete));
    if (openUid === toDelete)
      setOpenUid(null);
    setToDelete(null);
  };
  const askClose = () => {
    if (dirty)
      setLeaveConfirm(true);
    else
      props.onClose();
  };
  return (0, import_jsx_runtime6.jsxs)("div", { children: [(0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-toolbar", children: [(0, import_jsx_runtime6.jsx)(Btn, { size: "md", onClick: askClose, children: target.kind === "chat" ? t2("action.close") : t2("lorebookEditor.backToList") }), (0, import_jsx_runtime6.jsxs)("div", { style: { flex: 1, minWidth: 0 }, children: [(0, import_jsx_runtime6.jsx)("div", { className: "dsh-tavern-cardName", style: { fontSize: 15 }, children: target.name }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-editorMeta", children: [(0, import_jsx_runtime6.jsxs)(Muted, { children: [t2("lorebookEditor.meta", { kind: targetKindLabel(t2, target.kind), total: entries.length, enabled: enabledCount }), constantCount > 0 ? t2("lorebookEditor.metaConstant", { count: constantCount }) : ""] }), dirty ? (0, import_jsx_runtime6.jsx)(Badge, { accent: true, children: t2("lorebookEditor.unsaved") }) : null] })] }), (0, import_jsx_runtime6.jsx)(Btn, { size: "md", onClick: addEntry, children: t2("lorebookEditor.newEntry") }), (0, import_jsx_runtime6.jsx)(Btn, { primary: true, size: "md", disabled: busy || !dirty, onClick: () => void save(), children: t2("action.save") })] }), (0, import_jsx_runtime6.jsx)(Err, { message: error }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-search", style: { margin: "10px 0 12px" }, children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-searchIcon", children: (0, import_jsx_runtime6.jsx)(import_dsh_client_ui_primitives6.IconSearchOutline16, {}) }), (0, import_jsx_runtime6.jsx)("input", { value: query, placeholder: t2("lorebookEditor.searchPlaceholder"), onChange: (e) => {
    setQuery(e.target.value);
    setPage(0);
  } })] }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-filters", children: [[
    ["all", t2("lorebookEditor.filter.all", { count: entries.length })],
    ["on", t2("lorebookEditor.filter.on", { count: enabledCount })],
    ["off", t2("lorebookEditor.filter.off", { count: entries.length - enabledCount })],
    ["constant", t2("lorebookEditor.filter.constant", { count: constantCount })]
  ].map(([id, label]) => (0, import_jsx_runtime6.jsx)("button", { type: "button", className: "dsh-tavern-chip", "data-active": filter === id ? "true" : "false", onClick: () => {
    setFilter(id);
    setPage(0);
  }, children: label }, id)), (0, import_jsx_runtime6.jsx)("span", { style: { flex: 1 } }), (0, import_jsx_runtime6.jsx)(Btn, { size: "sm", onClick: () => applyFilterEnabled(true), disabled: filtered.length === 0, children: t2("lorebookEditor.enableFiltered") }), (0, import_jsx_runtime6.jsx)(Btn, { size: "sm", onClick: () => applyFilterEnabled(false), disabled: filtered.length === 0, children: t2("lorebookEditor.disableFiltered") })] }), filtered.length === 0 ? (0, import_jsx_runtime6.jsx)(Muted, { children: entries.length === 0 ? t2("lorebookEditor.empty") : t2("common.noMatch", { what: t2("lorebookEditor.entryNoun") }) }) : (0, import_jsx_runtime6.jsx)("div", { className: "dsh-tavern-list dsh-tavern-scroll", children: pageItems.map((entry) => {
    const open = openUid === entry.uid;
    return (0, import_jsx_runtime6.jsxs)("div", { className: `dsh-tavern-entry${open ? " is-open" : ""}${entry.enabled ? "" : " is-off"}`, children: [(0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-entryHead", onClick: () => setOpenUid(open ? null : entry.uid), children: [(0, import_jsx_runtime6.jsx)(Toggle, { checked: entry.enabled, title: entry.enabled ? t2("lorebookEditor.entry.disable") : t2("lorebookEditor.entry.enable"), onChange: (enabled) => patch(entry.uid, { enabled }) }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-entryMain", children: [(0, import_jsx_runtime6.jsx)("div", { className: "dsh-tavern-entryTitle", children: entryTitle(t2, entry) }), (0, import_jsx_runtime6.jsx)("div", { className: "dsh-tavern-entrySub", children: entrySub(t2, entry) })] }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-entryBadges", children: [entry.constant ? (0, import_jsx_runtime6.jsx)(Badge, { children: t2("lorebookEditor.constant") }) : null, entry.keys.length > 0 ? (0, import_jsx_runtime6.jsx)(Badge, { children: t2("lorebookEditor.entry.keys", { count: entry.keys.length }) }) : (0, import_jsx_runtime6.jsx)(Badge, { children: t2("lorebookEditor.entry.noKeys") })] }), (0, import_jsx_runtime6.jsx)("span", { className: `dsh-tavern-chevron${open ? " is-open" : ""}`, children: (0, import_jsx_runtime6.jsx)(import_dsh_client_ui_primitives6.IconChevronDownOutline14, {}) })] }), (0, import_jsx_runtime6.jsx)("div", { className: `dsh-tavern-collapse${open ? " is-open" : ""}`, children: (0, import_jsx_runtime6.jsx)("div", { className: "dsh-tavern-collapseInner", children: (0, import_jsx_runtime6.jsx)(EntryForm, { entry, advanced, onAdvanced: setAdvanced, onChange: (partial2) => patch(entry.uid, partial2), onDelete: () => setToDelete(entry.uid) }) }) })] }, entry.uid);
  }) }), pageCount > 1 && (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-pager", children: [(0, import_jsx_runtime6.jsx)(Btn, { size: "sm", disabled: safePage <= 0, onClick: () => setPage(safePage - 1), children: t2("lorebookEditor.pager.prev") }), (0, import_jsx_runtime6.jsx)(Muted, { children: t2("lorebookEditor.pager.status", { page: safePage + 1, pageCount, count: pageItems.length }) }), (0, import_jsx_runtime6.jsx)(Btn, { size: "sm", disabled: safePage >= pageCount - 1, onClick: () => setPage(safePage + 1), children: t2("lorebookEditor.pager.next") })] }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-stickyBar", children: [(0, import_jsx_runtime6.jsx)(Btn, { size: "md", onClick: addEntry, children: (0, import_jsx_runtime6.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 }, children: [(0, import_jsx_runtime6.jsx)(import_dsh_client_ui_primitives6.IconPlusOutline16, {}), " ", t2("lorebookEditor.newEntry")] }) }), (0, import_jsx_runtime6.jsx)(Btn, { primary: true, size: "md", disabled: busy || !dirty, onClick: () => void save(), children: t2("action.save") }), (0, import_jsx_runtime6.jsx)(Btn, { size: "md", onClick: askClose, children: dirty ? t2("lorebookEditor.discardAndBack") : t2("lorebookEditor.back") })] }), (0, import_jsx_runtime6.jsx)(ConfirmDialog, { open: toDelete !== null, title: t2("lorebookEditor.delete.title"), description: t2("lorebookEditor.delete.desc"), confirmLabel: t2("lorebookEditor.deleteEntry"), danger: true, onCancel: () => setToDelete(null), onConfirm: removeEntry }), (0, import_jsx_runtime6.jsx)(ConfirmDialog, { open: leaveConfirm, title: t2("lorebookEditor.discard.title"), description: t2("lorebookEditor.discard.desc"), confirmLabel: t2("lorebookEditor.discard.confirm"), danger: true, onCancel: () => setLeaveConfirm(false), onConfirm: () => {
    setLeaveConfirm(false);
    props.onClose();
  } })] });
}
function EntryForm(props) {
  const t2 = useT();
  const { entry } = props;
  const set = props.onChange;
  return (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-entryBody", onClick: (e) => e.stopPropagation(), children: [(0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.comment") }), (0, import_jsx_runtime6.jsx)("input", { className: "dsh-tavern-input", style: { width: "100%", height: 36, padding: "0 10px", fontSize: 13, boxSizing: "border-box" }, value: entry.comment, placeholder: t2("lorebookEditor.form.commentPlaceholder"), onChange: (e) => set({ comment: e.target.value }) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.keys") }), (0, import_jsx_runtime6.jsx)("input", { className: "dsh-tavern-input dsh-tavern-codeFont", style: { width: "100%", height: 36, padding: "0 10px", fontSize: 13, boxSizing: "border-box" }, value: joinKeys(entry.keys), placeholder: t2("lorebookEditor.form.keysPlaceholder"), onChange: (e) => set({ keys: splitKeys(e.target.value) }) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.content") }), (0, import_jsx_runtime6.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 120 }, value: entry.content, placeholder: t2("lorebookEditor.form.contentPlaceholder"), onChange: (e) => set({ content: e.target.value }) })] }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-inlineChecks", children: [(0, import_jsx_runtime6.jsxs)("label", { children: [(0, import_jsx_runtime6.jsx)(Toggle, { checked: entry.constant, onChange: (constant) => set({ constant }) }), t2("lorebookEditor.form.constant")] }), (0, import_jsx_runtime6.jsxs)("label", { children: [(0, import_jsx_runtime6.jsx)(Toggle, { checked: entry.selective, onChange: (selective) => set({ selective }) }), t2("lorebookEditor.form.selective")] }), (0, import_jsx_runtime6.jsxs)("label", { children: [(0, import_jsx_runtime6.jsx)(Toggle, { checked: entry.ignoreBudget, onChange: (ignoreBudget) => set({ ignoreBudget }) }), t2("lorebookEditor.form.ignoreBudget")] })] }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-fieldRow", children: [(0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.position") }), (0, import_jsx_runtime6.jsx)(Select, { size: "md", value: String(entry.position), onChange: (v) => set({ position: Number(v) }), options: positionOptions(t2) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.order") }), (0, import_jsx_runtime6.jsx)(NumInput, { value: entry.order, onChange: (order) => set({ order: Math.round(order) }) })] }), entry.position === 4 || entry.position === 7 ? (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: entry.position === 7 ? t2("lorebookEditor.form.outletName") : t2("lorebookEditor.form.depth") }), entry.position === 7 ? (0, import_jsx_runtime6.jsx)("input", { className: "dsh-tavern-input", style: { width: "100%", height: 36, padding: "0 10px", boxSizing: "border-box" }, value: entry.outletName, onChange: (e) => set({ outletName: e.target.value }) }) : (0, import_jsx_runtime6.jsx)(NumInput, { value: entry.depth, onChange: (depth) => set({ depth: Math.max(0, Math.round(depth)) }) })] }) : null] }), entry.selective ? (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-fieldRow", children: [(0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.secondaryKeys") }), (0, import_jsx_runtime6.jsx)("input", { className: "dsh-tavern-input dsh-tavern-codeFont", style: { width: "100%", height: 36, padding: "0 10px", fontSize: 13, boxSizing: "border-box" }, value: joinKeys(entry.secondaryKeys), placeholder: t2("lorebookEditor.form.secondaryKeysPlaceholder"), onChange: (e) => set({ secondaryKeys: splitKeys(e.target.value) }) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.selectiveLogic") }), (0, import_jsx_runtime6.jsx)(Select, { size: "md", value: String(entry.selectiveLogic), onChange: (v) => set({ selectiveLogic: Number(v) }), options: logicOptions(t2) })] })] }) : null, (0, import_jsx_runtime6.jsx)(Btn, { size: "sm", onClick: () => props.onAdvanced(!props.advanced), children: props.advanced ? t2("lorebookEditor.form.advanced.hide") : t2("lorebookEditor.form.advanced.show") }), props.advanced ? (0, import_jsx_runtime6.jsxs)(import_jsx_runtime6.Fragment, { children: [(0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-fieldRow", children: [(0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.probability") }), (0, import_jsx_runtime6.jsx)(NumInput, { value: entry.probability, onChange: (probability) => set({ probability }) })] }), (0, import_jsx_runtime6.jsx)("label", { className: "dsh-tavern-inlineChecks", style: { paddingTop: 22 }, children: (0, import_jsx_runtime6.jsxs)("span", { children: [(0, import_jsx_runtime6.jsx)(Toggle, { checked: entry.useProbability, onChange: (useProbability) => set({ useProbability }) }), " ", t2("lorebookEditor.form.useProbability")] }) }), entry.position === 4 ? (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.role") }), (0, import_jsx_runtime6.jsx)(Select, { size: "md", value: String(entry.role), onChange: (v) => set({ role: Number(v) }), options: ROLE_OPTIONS })] }) : null] }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-inlineChecks", children: [(0, import_jsx_runtime6.jsxs)("label", { children: [(0, import_jsx_runtime6.jsx)(Toggle, { checked: entry.excludeRecursion, onChange: (excludeRecursion) => set({ excludeRecursion }) }), t2("lorebookEditor.form.excludeRecursion")] }), (0, import_jsx_runtime6.jsxs)("label", { children: [(0, import_jsx_runtime6.jsx)(Toggle, { checked: entry.preventRecursion, onChange: (preventRecursion) => set({ preventRecursion }) }), t2("lorebookEditor.form.preventRecursion")] })] }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-fieldRow", children: [(0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.delayUntilRecursion") }), (0, import_jsx_runtime6.jsx)(NumInput, { value: entry.delayUntilRecursion, onChange: (delayUntilRecursion) => set({ delayUntilRecursion: Math.max(0, Math.round(delayUntilRecursion)) }) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: "sticky" }), (0, import_jsx_runtime6.jsx)(NullableNumInput, { value: entry.sticky, onChange: (sticky) => set({ sticky }) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: "cooldown" }), (0, import_jsx_runtime6.jsx)(NullableNumInput, { value: entry.cooldown, onChange: (cooldown) => set({ cooldown }) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: "delay" }), (0, import_jsx_runtime6.jsx)(NullableNumInput, { value: entry.delay, onChange: (delay) => set({ delay }) })] })] }), (0, import_jsx_runtime6.jsxs)("div", { className: "dsh-tavern-fieldRow", children: [(0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.scanDepth") }), (0, import_jsx_runtime6.jsx)(NullableNumInput, { value: entry.scanDepth, onChange: (scanDepth) => set({ scanDepth }) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.caseSensitive") }), (0, import_jsx_runtime6.jsx)(Select, { size: "md", value: triValue(entry.caseSensitive), onChange: (v) => set({ caseSensitive: triFrom(v) }), options: triStateOptions(t2) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.matchWholeWords") }), (0, import_jsx_runtime6.jsx)(Select, { size: "md", value: triValue(entry.matchWholeWords), onChange: (v) => set({ matchWholeWords: triFrom(v) }), options: triStateOptions(t2) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.group") }), (0, import_jsx_runtime6.jsx)("input", { className: "dsh-tavern-input", style: { width: "100%", height: 36, padding: "0 10px", boxSizing: "border-box" }, value: entry.group, onChange: (e) => set({ group: e.target.value }) })] }), (0, import_jsx_runtime6.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime6.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("lorebookEditor.form.groupWeight") }), (0, import_jsx_runtime6.jsx)(NumInput, { value: entry.groupWeight, onChange: (groupWeight) => set({ groupWeight: Math.max(0, Math.round(groupWeight)) }) })] })] }), (0, import_jsx_runtime6.jsx)("div", { className: "dsh-tavern-inlineChecks", children: (0, import_jsx_runtime6.jsxs)("label", { children: [(0, import_jsx_runtime6.jsx)(Toggle, { checked: entry.groupOverride, onChange: (groupOverride) => set({ groupOverride }) }), t2("lorebookEditor.form.groupOverride")] }) })] }) : null, (0, import_jsx_runtime6.jsx)("div", { style: { display: "flex", justifyContent: "flex-end" }, children: (0, import_jsx_runtime6.jsx)(IconBtn, { label: t2("lorebookEditor.deleteEntry"), danger: true, onClick: props.onDelete, children: (0, import_jsx_runtime6.jsx)(import_dsh_client_ui_primitives6.IconTrashOutline16, {}) }) })] });
}

// lib/client/types.js
var EMPTY_SESSION_DEFAULTS = {
  cardId: "",
  presetId: "",
  personaId: "",
  lorebookIds: [],
  characterLorebookId: ""
};

// lib/client/chip.js
var import_dsh_client_ui_primitives7 = require("@deepseek-ai/dsh-client-ui-primitives");
function defaultBinding(sessionId, cardId, defaults) {
  const d = defaults ?? EMPTY_SESSION_DEFAULTS;
  return {
    sessionId,
    cardId,
    presetId: d.presetId || null,
    personaId: d.personaId || null,
    lorebookIds: [...d.lorebookIds],
    characterLorebookId: d.characterLorebookId || null,
    interactiveCards: null,
    greetingIndex: 0,
    authorNote: "",
    injectJournal: false,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function bindingFromDefaults(remote, sessionId, cardId) {
  const r = await remote.getSettings({});
  if (!r.ok)
    throw new Error(r.error.message);
  return defaultBinding(sessionId, cardId, r.value.settings.defaults);
}
function PreDialog(props) {
  return (0, import_jsx_runtime7.jsx)(Dialog, { open: true, title: props.title, onClose: props.onClose, width: "lg", children: (0, import_jsx_runtime7.jsx)("pre", { className: "dsh-tavern-modalPre", children: props.text }) });
}
function fmtTokens(n) {
  if (n === null)
    return "?";
  return n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
function PromptPreviewDialog(props) {
  const { data } = props;
  const t2 = useT();
  const [tab, setTab] = (0, import_react7.useState)("actual");
  const toast = useToast();
  const wi = data.worldInfoBudget;
  const assemble = data.assembleBudget;
  const body = tab === "actual" ? data.actualRequest ? data.actualRequest.text + (data.actualRequest.truncated ? "\n" + t2("chip.preview.actualTruncated") : "") : t2("chip.preview.noActual") : tab === "standing" ? data.standing || t2("chip.preview.empty") : tab === "turn" ? data.turnContext || t2("chip.preview.empty") : tab === "log" ? data.logLines.join("\n") || t2("chip.preview.noLog") : `=== system ===
${data.system}

=== messages ===
${data.messages.map((m) => JSON.stringify(m)).join("\n\n")}`;
  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(body);
      toast.show(t2("chip.preview.copied"));
    } catch {
      toast.show(t2("chip.preview.copyFailed"));
    }
  };
  return (0, import_jsx_runtime7.jsxs)(Dialog, { open: true, title: t2("chip.preview.title"), onClose: props.onClose, width: "lg", children: [(0, import_jsx_runtime7.jsx)(Muted, { children: t2("chip.preview.notice") }), (0, import_jsx_runtime7.jsxs)(Muted, { children: [t2("chip.preview.budget", { used: wi.used, limit: wi.limit }), wi.overflowed ? ` \xB7 ${t2("chip.preview.overflowed")}` : "", " \xB7 ", t2("chip.preview.assemble", { after: assemble.tokensAfter, before: assemble.tokensBefore }), assemble.trimmedSections.length > 0 ? ` \xB7 ${t2("chip.preview.trimmed", { sections: assemble.trimmedSections.join(t2("chip.preview.listSep")) })}` : ""] }), (0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-filters", style: { margin: "10px 0 12px" }, children: [(0, import_jsx_runtime7.jsx)(Tabs, { size: "sm", value: tab, onChange: (id) => setTab(id), items: [
    { id: "actual", label: t2("chip.preview.actual") },
    { id: "standing", label: "standing" },
    { id: "turn", label: t2("chip.preview.tab.turn") },
    { id: "full", label: t2("chip.preview.tab.full") },
    { id: "log", label: t2("binding.triggerLog") }
  ] }), (0, import_jsx_runtime7.jsx)("span", { style: { flex: 1 } }), (0, import_jsx_runtime7.jsx)(IconBtn, { label: t2("chip.preview.copyView"), onClick: () => void copyBody(), children: (0, import_jsx_runtime7.jsx)(import_dsh_client_ui_primitives7.IconCopyOutline16, {}) })] }), (0, import_jsx_runtime7.jsx)("pre", { className: "dsh-tavern-modalPre", children: body }), toast.node] });
}
function TavernHeaderChip(props) {
  const { remote, sessionId, sessions } = props;
  const t2 = useT();
  const tavern = isTavernSession(props.useSessions, sessionId);
  const bindingLoader = useLoader(() => cachedSessionBinding(remote, sessionId), [sessionId], tavern);
  const binding = bindingLoader.state.status === "ready" ? bindingLoader.state.value.binding : null;
  const canSwipeGreeting = bindingLoader.state.status === "ready" ? bindingLoader.state.value.canSwipeGreeting !== false : false;
  const detail = useLoader(async () => {
    const [d, a] = await Promise.all([cachedCharacterDetail(remote, binding.cardId), cachedAvatar(remote, binding.cardId)]);
    if (!d.ok)
      return d;
    return { ok: true, value: { name: d.value.name, avatar: a.ok ? a.value.dataUrl : null } };
  }, [binding?.cardId], tavern && binding !== null);
  const listsLoader = useLoader(() => remote.listCharacters({}), [sessionId], tavern);
  const listed = listsLoader.state.status === "ready" ? listsLoader.state.value.items : [];
  const listedName = binding ? listed.find((c) => c.cardId === binding.cardId)?.name : void 0;
  const [open, setOpen] = (0, import_react7.useState)(false);
  const usageLoader = useLoader(() => remote.getContextUsage({ sessionId }), [sessionId, open], tavern && open);
  const usage = usageLoader.state.status === "ready" ? usageLoader.state.value.usage : null;
  const [lists, setLists] = (0, import_react7.useState)(null);
  const [draft, setDraft] = (0, import_react7.useState)(null);
  const [error, setError] = (0, import_react7.useState)(null);
  const toast = useToast();
  const [view, setView] = (0, import_react7.useState)(null);
  const [previewData, setPreviewData] = (0, import_react7.useState)(null);
  const [chatLore, setChatLore] = (0, import_react7.useState)(null);
  const [confirmUnbind, setConfirmUnbind] = (0, import_react7.useState)(false);
  const [unbindBusy, setUnbindBusy] = (0, import_react7.useState)(false);
  const characterRequest = (0, import_react7.useRef)(0);
  (0, import_react7.useEffect)(() => {
    if (!open)
      return;
    let alive = true;
    setError(null);
    void (async () => {
      try {
        const [chars, presets, personas, lorebooks] = await Promise.all([
          remote.listCharacters({}),
          remote.listPresets({}),
          remote.listPersonas({}),
          remote.listLorebooks({})
        ]);
        if (!alive)
          return;
        if (!chars.ok)
          return setError(chars.error.message);
        if (!presets.ok)
          return setError(presets.error.message);
        if (!personas.ok)
          return setError(personas.error.message);
        if (!lorebooks.ok)
          return setError(lorebooks.error.message);
        setLists({
          characters: chars.value.items,
          presets: presets.value.items,
          personas: personas.value.items,
          lorebooks: lorebooks.value.items
        });
      } catch (cause) {
        if (alive)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);
  (0, import_react7.useEffect)(() => {
    if (!open) {
      characterRequest.current += 1;
      setDraft(null);
      return;
    }
    if (draft !== null)
      return;
    if (binding)
      setDraft({ ...binding, lorebookIds: [...binding.lorebookIds] });
  }, [open, binding, draft, sessionId]);
  if (!tavern)
    return null;
  const name2 = detail.state.status === "ready" ? detail.state.value.name : null;
  const avatar = detail.state.status === "ready" ? detail.state.value.avatar : null;
  const selectedChar = lists && draft ? lists.characters.find((c) => c.cardId === draft.cardId) : void 0;
  const embeddedBookLabel = selectedChar?.hasCharacterBook ? typeof selectedChar.characterBookEntryCount === "number" ? t2("chip.embeddedBook.withCount", {
    name: selectedChar.characterBookName || selectedChar.name,
    count: selectedChar.characterBookEntryCount
  }) : t2("chip.embeddedBook.noCount", { name: selectedChar.characterBookName || selectedChar.name }) : t2("chip.embeddedBook.none");
  const saveBinding = async () => {
    if (!draft)
      return;
    const r = await remote.setSessionBinding({ binding: draft });
    const err = errOf(r);
    if (err)
      setError(err);
    else {
      toast.show(t2("chip.saved"));
      invalidateSessionBinding(sessionId);
      bindingLoader.reload();
      window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
    }
  };
  const insertGreeting = async () => {
    const r = await remote.ensureGreeting({ sessionId });
    if (!r.ok)
      setError(r.error.message);
    else
      toast.show(r.value.created ? t2("chip.greeting.inserted") : t2("chip.greeting.skipped"));
  };
  const swipeBy = async (delta) => {
    if (!binding)
      return;
    const variants = await cachedCharacterDetail(remote, binding.cardId);
    if (!variants.ok) {
      setError(variants.error.message);
      return;
    }
    const total = 1 + variants.value.alternateGreetings.length;
    if (total < 2) {
      toast.show(t2("chip.swipe.none"));
      return;
    }
    const next = ((binding.greetingIndex + delta) % total + total) % total;
    const r = await remote.swipeGreeting({ sessionId, index: next });
    if (!r.ok)
      setError(r.error.message);
    else {
      await openChildSession(sessions, r.value.childSessionId, r.value.title).catch(() => {
        toast.show(t2("chip.swipe.childCreated"));
      });
    }
  };
  const unbind = async () => {
    setUnbindBusy(true);
    try {
      const r = await remote.clearSessionBinding({ sessionId });
      const err = errOf(r);
      if (err) {
        setConfirmUnbind(false);
        setError(err);
      } else {
        setConfirmUnbind(false);
        setOpen(false);
        invalidateSessionBinding(sessionId);
        bindingLoader.reload();
        window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
      }
    } finally {
      setUnbindBusy(false);
    }
  };
  const showTriggerLog = async () => {
    const r = await remote.getTriggerLog({ sessionId });
    if (!r.ok)
      return setError(r.error.message);
    const log = r.value.log;
    setView({
      title: t2("binding.triggerLog"),
      text: log ? `${t2("chip.log.time", { at: log.at })}

${log.lines.join("\n")}` : t2("chip.log.empty")
    });
  };
  const preview = async () => {
    const r = await remote.previewPrompt({ sessionId });
    if (!r.ok)
      return setError(r.error.message);
    setPreviewData(r.value);
  };
  const openChatLore = async () => {
    const cardId = draft?.cardId;
    if (!cardId || cardId !== binding?.cardId || !binding.storyId)
      return;
    const r = await remote.getChatLorebook({ cardId, storyId: binding?.cardId === cardId ? binding.storyId : void 0 });
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    try {
      setChatLore({
        cardId,
        storyId: binding?.cardId === cardId ? binding.storyId : void 0,
        entries: parseLorebook(r.value.json, { source: "chat", sourceRef: "chat-lorebook" })
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (0, import_jsx_runtime7.jsxs)("span", { className: "dsh-tavern-ui", style: { display: "inline-flex" }, children: [(0, import_jsx_runtime7.jsx)(TavernSeatChip, { label: binding ? name2 ?? listedName ?? t2("chip.characterFallback") : t2("hero.pickCharacter"), title: t2("hero.pickCharacter"), avatarUrl: avatar, open, loading: bindingLoader.state.status === "loading", hasPopup: "dialog", onClick: () => setOpen(!open) }), (0, import_jsx_runtime7.jsx)(Dialog, { open, title: t2("chip.dialog.title"), onClose: () => setOpen(false), width: "full", footer: draft ? (0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-footActions", children: [binding ? (0, import_jsx_runtime7.jsx)(Btn, { danger: true, size: "md", onClick: () => {
    setConfirmUnbind(true);
  }, children: t2("chip.unbind.action") }) : null, (0, import_jsx_runtime7.jsx)("span", { className: "dsh-tavern-footSpacer" }), (0, import_jsx_runtime7.jsxs)("span", { className: "dsh-tavern-footGroup", children: [(0, import_jsx_runtime7.jsx)(Btn, { size: "md", disabled: !binding?.storyId || draft?.cardId !== binding.cardId, onClick: () => void openChatLore(), children: t2("chip.chatLore.edit") }), (0, import_jsx_runtime7.jsx)(Btn, { primary: true, size: "md", onClick: () => void saveBinding(), children: t2("binding.save") })] })] }) : void 0, children: (0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-binding dsh-tavern-bindingWide", children: [(0, import_jsx_runtime7.jsx)(Err, { message: error }), !lists && (0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-panelCard", children: [(0, import_jsx_runtime7.jsx)(Skeleton, { height: 14, width: "24%" }), (0, import_jsx_runtime7.jsx)(Skeleton, { height: 38, radius: 18 }), (0, import_jsx_runtime7.jsx)(Skeleton, { height: 38, radius: 18 }), (0, import_jsx_runtime7.jsx)(Skeleton, { height: 38, radius: 18 })] }), lists && (0, import_jsx_runtime7.jsxs)(import_jsx_runtime7.Fragment, { children: [draft ? (0, import_jsx_runtime7.jsxs)(import_jsx_runtime7.Fragment, { children: [(0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-panelCard", children: [(0, import_jsx_runtime7.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("chip.group.binding") }), (0, import_jsx_runtime7.jsx)(Field, { label: t2("chip.field.character"), children: (0, import_jsx_runtime7.jsx)(Select, { width: "100%", value: draft.cardId, onChange: (cardId) => {
    if (!cardId)
      return;
    const picked = lists.characters.find((c) => c.cardId === cardId);
    setDraft({ ...draft, cardId, cardName: picked?.name ?? draft.cardName });
  }, options: [
    { value: "", label: t2("chip.field.selectCharacter") },
    ...lists.characters.map((c) => ({ value: c.cardId, label: c.name }))
  ] }) }), (0, import_jsx_runtime7.jsx)(Field, { label: t2("chip.field.preset"), children: (0, import_jsx_runtime7.jsx)(Select, { width: "100%", value: draft.presetId ?? "", onChange: (v) => setDraft({ ...draft, presetId: v || null }), options: [{ value: "", label: t2("chip.field.builtinPreset") }, ...lists.presets.map((p) => ({ value: p.id, label: p.regexCount > 0 ? t2("settings.defaults.presetRegexCount", { name: p.name, count: p.regexCount }) : p.name }))] }) }), (0, import_jsx_runtime7.jsx)(Field, { label: t2("chip.field.persona"), children: (0, import_jsx_runtime7.jsx)(Select, { width: "100%", value: draft.personaId ?? "", onChange: (v) => setDraft({ ...draft, personaId: v || null }), options: [{ value: "", label: t2("chip.field.none") }, ...lists.personas.map((p) => ({ value: p.id, label: p.name }))] }) })] }), (0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-panelCard", children: [(0, import_jsx_runtime7.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("section.lorebooks") }), (0, import_jsx_runtime7.jsx)(Field, { label: t2("chip.field.mainLore"), children: (0, import_jsx_runtime7.jsx)(Select, { width: "100%", value: draft.characterLorebookId ?? "", onChange: (v) => setDraft({ ...draft, characterLorebookId: v || null }), options: [
    { value: "", label: embeddedBookLabel },
    ...lists.lorebooks.map((n) => ({ value: n, label: n }))
  ] }) }), (0, import_jsx_runtime7.jsx)(Field, { label: t2("chip.field.globalLore"), children: lists.lorebooks.length === 0 ? (0, import_jsx_runtime7.jsx)(Muted, { children: t2("chip.field.noLorebooks") }) : (0, import_jsx_runtime7.jsx)(CheckChips, { ariaLabel: t2("chip.field.globalLoreAria"), options: lists.lorebooks.map((n) => ({ value: n, label: n })), selected: draft.lorebookIds, onChange: (lorebookIds) => setDraft({ ...draft, lorebookIds }) }) })] }), (0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-panelCard", children: [(0, import_jsx_runtime7.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("chip.group.turnInject") }), (0, import_jsx_runtime7.jsx)(Field, { label: t2("chip.field.authorNote"), children: (0, import_jsx_runtime7.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 96 }, value: draft.authorNote ?? "", onChange: (e) => setDraft({ ...draft, authorNote: e.target.value }) }) }), (0, import_jsx_runtime7.jsx)("div", { className: "dsh-tavern-inlineChecks", children: (0, import_jsx_runtime7.jsxs)("label", { children: [(0, import_jsx_runtime7.jsx)(Toggle, { checked: draft.injectJournal === true, onChange: (injectJournal) => setDraft({ ...draft, injectJournal }) }), t2("chip.field.injectJournal")] }) })] })] }) : (0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-panelCard", children: [(0, import_jsx_runtime7.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("chip.group.binding") }), (0, import_jsx_runtime7.jsx)(Field, { label: t2("chip.field.character"), children: (0, import_jsx_runtime7.jsx)(Select, { width: "100%", value: "", onChange: (cardId) => {
    if (!cardId)
      return;
    const request = ++characterRequest.current;
    void bindingFromDefaults(remote, sessionId, cardId).then((next) => {
      if (characterRequest.current !== request)
        return;
      const picked = lists.characters.find((c) => c.cardId === cardId);
      setDraft({ ...next, cardName: picked?.name });
    }).catch((cause) => {
      if (characterRequest.current === request) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }, options: [
    { value: "", label: t2("chip.field.selectCharacter") },
    ...lists.characters.map((c) => ({ value: c.cardId, label: c.name }))
  ] }) })] }), (0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-panelCard", children: [(0, import_jsx_runtime7.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("chip.group.greetingDebug") }), (0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-bindingActions", children: [(0, import_jsx_runtime7.jsx)(Btn, { disabled: !binding, onClick: () => void insertGreeting(), children: t2("binding.greeting") }), (0, import_jsx_runtime7.jsx)(Btn, { disabled: !binding || !canSwipeGreeting, onClick: () => void swipeBy(-1), children: t2("chip.greeting.prev") }), (0, import_jsx_runtime7.jsx)(Btn, { disabled: !binding || !canSwipeGreeting, onClick: () => void swipeBy(1), children: t2("chip.greeting.next") }), (0, import_jsx_runtime7.jsx)(Btn, { onClick: () => void showTriggerLog(), children: t2("binding.triggerLog") }), (0, import_jsx_runtime7.jsx)(Btn, { onClick: () => void preview(), children: t2("binding.preview") })] })] }), usage && (0, import_jsx_runtime7.jsxs)("div", { className: "dsh-tavern-usageBar", children: [typeof usage.percent === "number" && (0, import_jsx_runtime7.jsx)("div", { className: "dsh-tavern-meter", role: "progressbar", "aria-label": t2("chip.usage.aria"), "aria-valuenow": Math.round(usage.percent), "aria-valuemin": 0, "aria-valuemax": 100, children: (0, import_jsx_runtime7.jsx)("span", { className: "dsh-tavern-meterFill", "data-warn": usage.percent >= 90 ? "true" : "false", style: { width: `${Math.min(100, Math.max(0, usage.percent))}%` } }) }), (0, import_jsx_runtime7.jsxs)(Muted, { children: [t2("chip.usage.label"), usage.contextWindow !== null && usage.pressureTokens !== null ? t2("chip.usage.full", { used: fmtTokens(usage.pressureTokens), window: fmtTokens(usage.contextWindow), percent: usage.percent ?? "?" }) : t2("chip.usage.approx", { tokens: fmtTokens(usage.surfaceTokens) }), usage.messageTokens !== null ? ` \xB7 ${t2("chip.usage.breakdown", { system: fmtTokens(usage.systemTokens), tools: fmtTokens(usage.toolsTokens), messages: fmtTokens(usage.messageTokens) })}` : ""] })] })] })] }) }), toast.node, view && (0, import_jsx_runtime7.jsx)(PreDialog, { title: view.title, text: view.text, onClose: () => setView(null) }), previewData && (0, import_jsx_runtime7.jsx)(PromptPreviewDialog, { data: previewData, onClose: () => setPreviewData(null) }), chatLore && (0, import_jsx_runtime7.jsx)(Dialog, { open: true, width: "xl", title: t2("chip.chatLore.title"), onClose: () => setChatLore(null), children: (0, import_jsx_runtime7.jsx)(LorebookEditor, { target: { kind: "chat", cardId: chatLore.cardId, name: t2("chip.chatLore.title") }, entries: chatLore.entries, onClose: () => setChatLore(null), onSaved: () => {
    toast.show(t2("chip.chatLore.saved"));
    setChatLore(null);
  }, save: (json) => remote.saveChatLorebook({ cardId: chatLore.cardId, storyId: chatLore.storyId, json }) }) }), (0, import_jsx_runtime7.jsx)(ConfirmDialog, { open: confirmUnbind, title: t2("chip.unbind.title"), description: t2("chip.unbind.desc"), confirmLabel: t2("chip.unbind.action"), danger: true, busy: unbindBusy, onCancel: () => {
    setConfirmUnbind(false);
  }, onConfirm: () => void unbind() })] });
}

// lib/client/hero.js
var import_jsx_runtime8 = require("react/jsx-runtime");
var import_react8 = require("react");
var import_react_dom = require("react-dom");
var import_dsh_client_ui_primitives8 = require("@deepseek-ai/dsh-client-ui-primitives");

// lib/core/persona.js
var DEFAULT_USER_NAME = "User";

// lib/client/hero.js
function isSafeChipHost(el, from) {
  return el.tagName !== "BUTTON" && el.closest("button") === null && el !== from && !from.contains(el);
}
function findHeroChipRow(from) {
  const seat = from?.closest("[data-composer-seat]");
  if (!(seat instanceof HTMLElement) || !from)
    return null;
  let node = from;
  while (node && node !== seat) {
    const prev = node.previousElementSibling;
    if (prev instanceof HTMLElement && isSafeChipHost(prev, from) && prev.querySelector('button[aria-haspopup="menu"]')) {
      return prev;
    }
    node = node.parentElement;
  }
  const buttons = Array.from(seat.querySelectorAll('button[aria-haspopup="menu"]')).filter((b) => !b.closest("[data-tavern-hero-seat]"));
  for (const btn of buttons) {
    let parent = btn.parentElement;
    while (parent && parent !== seat) {
      if (isSafeChipHost(parent, from) && getComputedStyle(parent).display === "flex" && parent.querySelectorAll('button[aria-haspopup="menu"]').length >= 2) {
        return parent;
      }
      parent = parent.parentElement;
    }
  }
  return null;
}
function greetingVariants(detail) {
  return [detail.firstMes, ...detail.alternateGreetings];
}
function TavernHeroCharacter(props) {
  const { remote, sessionId, session } = props;
  const t2 = useT();
  const tavern = isTavernSession(props.useSessions, sessionId);
  const showHero = tavern && session?.blank === true && session.promptAttempted !== true;
  const dockRef = (0, import_react8.useRef)(null);
  const [chipHost, setChipHost] = (0, import_react8.useState)(null);
  const [open, setOpen] = (0, import_react8.useState)(false);
  const [busy, setBusy] = (0, import_react8.useState)(false);
  const [error, setError] = (0, import_react8.useState)(null);
  const bindingLoader = useLoader(() => cachedSessionBinding(remote, sessionId), [sessionId], showHero);
  const binding = bindingLoader.state.status === "ready" ? bindingLoader.state.value.binding : null;
  const userName = bindingLoader.state.status === "ready" ? bindingLoader.state.value.userName || DEFAULT_USER_NAME : DEFAULT_USER_NAME;
  const charsLoader = useLoader(() => remote.listCharacters({}), [sessionId], showHero);
  const characters = charsLoader.state.status === "ready" ? charsLoader.state.value.items : [];
  const detailLoader = useLoader(() => cachedCharacterDetail(remote, binding.cardId), [binding?.cardId], showHero && binding !== null);
  const avatarLoader = useLoader(() => cachedAvatar(remote, binding.cardId), [binding?.cardId], showHero && binding !== null);
  (0, import_react8.useEffect)(() => {
    if (!showHero)
      return;
    const onChanged = (e) => {
      if (e.detail === sessionId)
        bindingLoader.reload();
    };
    window.addEventListener(BINDING_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(BINDING_CHANGED_EVENT, onChanged);
  }, [showHero, sessionId]);
  const picking = (0, import_react8.useRef)(false);
  const clearing = (0, import_react8.useRef)(false);
  const sweptSession = (0, import_react8.useRef)(null);
  (0, import_react8.useEffect)(() => {
    sweptSession.current = null;
    picking.current = false;
  }, [sessionId]);
  (0, import_react8.useEffect)(() => {
    if (!showHero) {
      picking.current = false;
      return;
    }
    if (picking.current || busy || clearing.current)
      return;
    if (bindingLoader.state.status !== "ready")
      return;
    if (sweptSession.current === sessionId)
      return;
    sweptSession.current = sessionId;
    if (!binding)
      return;
    clearing.current = true;
    void (async () => {
      try {
        if (picking.current)
          return;
        const r = await remote.clearSessionBinding({ sessionId });
        if (picking.current)
          return;
        const err = errOf(r);
        if (err) {
          setError(err);
          return;
        }
        invalidateSessionBinding(sessionId);
        window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
        bindingLoader.reload();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        clearing.current = false;
      }
    })();
  }, [showHero, bindingLoader.state.status, binding?.cardId, sessionId]);
  (0, import_react8.useLayoutEffect)(() => {
    if (!showHero) {
      setChipHost(null);
      return;
    }
    const apply2 = () => {
      const host = findHeroChipRow(dockRef.current);
      setChipHost((prev) => prev === host ? prev : host);
      return host;
    };
    if (apply2())
      return;
    const seat = dockRef.current?.closest("[data-composer-seat]");
    const root = seat instanceof HTMLElement ? seat : document.body;
    const obs = new MutationObserver(() => {
      if (apply2())
        obs.disconnect();
    });
    obs.observe(root, { childList: true, subtree: true });
    const timer = window.setTimeout(() => {
      apply2();
      obs.disconnect();
    }, 2e3);
    return () => {
      obs.disconnect();
      window.clearTimeout(timer);
    };
  }, [showHero, sessionId, binding?.cardId]);
  if (!showHero)
    return null;
  const detail = detailLoader.state.status === "ready" ? detailLoader.state.value : null;
  const avatar = avatarLoader.state.status === "ready" ? avatarLoader.state.value.dataUrl : null;
  const selected = binding ? characters.find((c) => c.cardId === binding.cardId) : void 0;
  const chipLabel = binding ? detail?.name ?? selected?.name ?? t2("hero.characterFallback") : t2("hero.pickCharacter");
  const variants = detail ? greetingVariants(detail) : [];
  const greetingIndex = binding?.greetingIndex ?? 0;
  const greetingText = detail ? expandIdentityMacros(variants[greetingIndex] ?? variants[0] ?? "", { char: detail?.name ?? chipLabel, user: userName }) : "";
  const hasAnyGreeting = variants.some((v) => v.trim() !== "");
  const metaParts = [];
  if (detail?.creator)
    metaParts.push(t2("hero.creator", { name: detail.creator }));
  if (detail?.characterVersion)
    metaParts.push(`v${detail.characterVersion}`);
  if (detail && detail.tags.length > 0)
    metaParts.push(detail.tags.slice(0, 3).join(" \xB7 "));
  const pickCharacter = async (cardId) => {
    if (!cardId || busy)
      return;
    picking.current = true;
    sweptSession.current = sessionId;
    setBusy(true);
    setError(null);
    try {
      while (clearing.current)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const next = await bindingFromDefaults(remote, sessionId, cardId);
      const saved = await remote.setSessionBinding({ binding: next });
      const saveErr = errOf(saved);
      if (saveErr) {
        setError(saveErr);
        return;
      }
      invalidateSessionBinding(sessionId);
      window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
      bindingLoader.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const startConversation = async () => {
    if (!binding || busy)
      return;
    picking.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!greetingText.trim() && hasAnyGreeting) {
        setError(t2("hero.error.emptyGreetingVariant"));
        return;
      }
      if (!greetingText.trim()) {
        setError(t2("hero.error.noGreetingInput"));
        return;
      }
      const entered = await remote.ensureGreeting({ sessionId });
      const enterErr = errOf(entered);
      if (enterErr)
        setError(enterErr);
      else if (entered.ok && !entered.value.created) {
        setError(t2("hero.error.enterFailed"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const swipeTo = async (index) => {
    if (!binding || busy)
      return;
    setBusy(true);
    setError(null);
    try {
      const saved = await remote.setSessionBinding({ binding: { ...binding, greetingIndex: index } });
      const saveErr = errOf(saved);
      if (saveErr)
        setError(saveErr);
      else {
        invalidateSessionBinding(sessionId);
        window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
        bindingLoader.reload();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const swipe = async (delta) => {
    if (!binding || variants.length < 2)
      return;
    const next = ((greetingIndex + delta) % variants.length + variants.length) % variants.length;
    await swipeTo(next);
  };
  const chip = (0, import_jsx_runtime8.jsx)("span", { "data-tavern-hero-seat": "", className: "dsh-tavern-ui", children: (0, import_jsx_runtime8.jsx)(import_dsh_client_ui_primitives8.Menu, { open, portal: true, compact: true, align: "start", selectedId: binding?.cardId, onClose: () => setOpen(false), onSelect: (id) => {
    setOpen(false);
    void pickCharacter(id);
  }, items: characters.length === 0 ? [{ id: "__empty__", label: charsLoader.state.status === "loading" ? t2("hero.loadingCharacters") : t2("hero.noCharacters"), disabled: true }] : characters.map((c) => ({
    id: c.cardId,
    label: !c.hasCharacterBook ? c.name : typeof c.characterBookEntryCount === "number" && c.characterBookEntryCount > 0 ? t2("hero.pickBook.withCount", { name: c.name, count: c.characterBookEntryCount }) : t2("hero.pickBook.noCount", { name: c.name })
  })), anchor: (0, import_jsx_runtime8.jsx)(TavernSeatChip, { label: chipLabel, title: t2("hero.pickCharacter"), avatarUrl: avatar, open, loading: bindingLoader.state.status === "loading", disabled: busy, onClick: () => setOpen((v) => !v) }) }) });
  return (0, import_jsx_runtime8.jsxs)("div", { ref: dockRef, "data-tavern-hero-root": "", className: "dsh-tavern-ui", children: [chipHost ? (0, import_react_dom.createPortal)(chip, chipHost) : chip, error && (0, import_jsx_runtime8.jsx)("div", { className: "dsh-tavern-hero-error", children: error }), binding && detailLoader.state.status === "loading" && (0, import_jsx_runtime8.jsxs)("div", { className: "dsh-tavern-hero-preview", "aria-busy": "true", children: [(0, import_jsx_runtime8.jsxs)("div", { className: "dsh-tavern-hero-previewHead", children: [(0, import_jsx_runtime8.jsx)(Skeleton, { width: 28, height: 28, radius: 999 }), (0, import_jsx_runtime8.jsx)(Skeleton, { width: 140, height: 14 })] }), (0, import_jsx_runtime8.jsx)(Skeleton, { height: 14, style: { marginTop: 14 } }), (0, import_jsx_runtime8.jsx)(Skeleton, { height: 14, width: "72%", style: { marginTop: 8 } }), (0, import_jsx_runtime8.jsx)(Skeleton, { height: 14, width: "48%", style: { marginTop: 8 } }), (0, import_jsx_runtime8.jsx)(Skeleton, { height: 32, width: 104, radius: 18, style: { marginTop: 14 } })] }), binding && detailLoader.state.status !== "loading" && (0, import_jsx_runtime8.jsxs)("div", { className: "dsh-tavern-hero-preview dsh-tavern-rise", tabIndex: variants.length > 1 ? 0 : void 0, onKeyDown: (e) => {
    if (variants.length < 2 || e.target !== e.currentTarget)
      return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      void swipe(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      void swipe(1);
    }
  }, children: [(0, import_jsx_runtime8.jsxs)("div", { className: "dsh-tavern-hero-previewHead", children: [(0, import_jsx_runtime8.jsx)(Avatar, { url: avatar, name: chipLabel, size: 40, className: "dsh-tavern-speechAvatar" }), (0, import_jsx_runtime8.jsxs)("div", { className: "dsh-tavern-hero-previewHeadText", children: [(0, import_jsx_runtime8.jsx)("div", { className: "dsh-tavern-hero-previewName", children: chipLabel }), metaParts.length > 0 && (0, import_jsx_runtime8.jsx)("div", { className: "dsh-tavern-hero-previewMeta", children: metaParts.join(" \xB7 ") })] })] }), detailLoader.state.status === "error" ? (0, import_jsx_runtime8.jsx)("div", { className: "dsh-tavern-hero-previewText", children: t2("hero.detailLoadFailed") }) : greetingText ? (0, import_jsx_runtime8.jsx)("div", { className: "dsh-tavern-hero-quote", children: greetingText }) : hasAnyGreeting ? (0, import_jsx_runtime8.jsx)("div", { className: "dsh-tavern-hero-previewText", children: t2("hero.emptyVariantHint") }) : (0, import_jsx_runtime8.jsx)("div", { className: "dsh-tavern-hero-previewText", children: t2("hero.noGreetingHint") }), (0, import_jsx_runtime8.jsxs)("div", { className: "dsh-tavern-hero-actions", children: [(0, import_jsx_runtime8.jsx)(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void startConversation(), children: t2("hero.start") }), variants.length > 1 && (0, import_jsx_runtime8.jsxs)("div", { className: "dsh-tavern-hero-swipe", children: [(0, import_jsx_runtime8.jsx)("button", { type: "button", className: "dsh-tavern-hero-swipeBtn", disabled: busy, title: t2("hero.prevGreeting"), onClick: () => void swipe(-1), children: (0, import_jsx_runtime8.jsx)(import_dsh_client_ui_primitives8.IconChevronLeftOutline14, {}) }), (0, import_jsx_runtime8.jsxs)("span", { className: "dsh-tavern-hero-swipeIdx", children: [greetingIndex + 1, "/", variants.length] }), (0, import_jsx_runtime8.jsx)("button", { type: "button", className: "dsh-tavern-hero-swipeBtn", disabled: busy, title: t2("hero.nextGreeting"), onClick: () => void swipe(1), children: (0, import_jsx_runtime8.jsx)(import_dsh_client_ui_primitives8.IconChevronRightOutline14, {}) }), (0, import_jsx_runtime8.jsx)("span", { className: "dsh-tavern-hero-swipeHint", children: t2("hero.swipeHint") })] })] })] })] });
}

// lib/client/panel/index.js
var import_jsx_runtime16 = require("react/jsx-runtime");
var import_react16 = require("react");

// lib/client/panel/characters.js
var import_jsx_runtime9 = require("react/jsx-runtime");
var import_react9 = require("react");
var import_dsh_client_ui_primitives9 = require("@deepseek-ai/dsh-client-ui-primitives");
var CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">`;
function withCsp(html) {
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + CSP_META + html.slice(at);
  }
  return CSP_META + html;
}
function CardAvatar(props) {
  const { state } = useLoader(() => cachedAvatar(props.remote, props.cardId), [props.cardId]);
  const url = state.status === "ready" ? state.value.dataUrl : null;
  return (0, import_jsx_runtime9.jsx)(Avatar, { url, name: props.name, size: props.size });
}
function CharacterCard(props) {
  const t2 = useT();
  const { state } = useLoader(() => cachedAvatar(props.remote, props.item.cardId), [props.item.cardId]);
  const url = state.status === "ready" ? state.value.dataUrl : null;
  const initial = props.item.name.trim().charAt(0) || "?";
  const book = props.item.characterBookName ? t2("characters.card.embeddedBookNamed", { name: props.item.characterBookName }) : t2("characters.card.embeddedBook");
  const meta2 = props.item.hasCharacterBook ? `${book}${typeof props.item.characterBookEntryCount === "number" && props.item.characterBookEntryCount > 0 ? ` \xB7 ${t2("characters.card.entryCount", { count: props.item.characterBookEntryCount })}` : ""}` : "";
  return (0, import_jsx_runtime9.jsxs)("article", { className: "dsh-tavern-charCard", ...clickableProps(() => props.onOpen(props.item.cardId)), children: [(0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-charCardCover", children: url ? (0, import_jsx_runtime9.jsx)("img", { src: url, alt: "" }) : (0, import_jsx_runtime9.jsx)("span", { className: "dsh-tavern-charCardInitial", children: initial }) }), (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-charCardBar", children: [(0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-charCardName", children: props.item.name }), meta2 ? (0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-charCardMeta", children: meta2 }) : null] }), (0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-charCardActions", children: (0, import_jsx_runtime9.jsx)(import_dsh_client_ui_primitives9.Tooltip, { label: t2("characters.card.delete"), side: "bottom", children: (0, import_jsx_runtime9.jsx)("button", { type: "button", "aria-label": t2("characters.card.delete"), className: "dsh-tavern-coverBtn is-danger", disabled: props.busy, onClick: (e) => {
    e.stopPropagation();
    props.onDelete(props.item);
  }, children: (0, import_jsx_runtime9.jsx)(import_dsh_client_ui_primitives9.IconTrashOutline16, {}) }) }) })] });
}
function LabeledArea(props) {
  return (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime9.jsx)("span", { className: "dsh-tavern-fieldLabel", children: props.label }), (0, import_jsx_runtime9.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: props.minHeight ?? 64 }, value: props.value, onChange: (e) => props.onChange(e.target.value) })] });
}
function CharacterDetailDialog(props) {
  const { remote, cardId } = props;
  const t2 = useT();
  const { state, reload } = useLoader(() => cachedCharacterDetail(remote, cardId), [cardId]);
  const [cardOpen, setCardOpen] = (0, import_react9.useState)(false);
  const [draft, setDraft] = (0, import_react9.useState)(null);
  const [error, setError] = (0, import_react9.useState)(null);
  const [busy, setBusy] = (0, import_react9.useState)(false);
  const toast = useToast();
  const loaded = state.status === "ready" ? state.value : null;
  const detail = draft ?? loaded;
  (0, import_react9.useEffect)(() => {
    if (loaded)
      setDraft(loaded);
  }, [loaded]);
  const set = (patch) => setDraft(detail ? { ...detail, ...patch } : detail);
  const interactiveHtml = typeof detail?.extensions?.interactiveHtml === "string" ? detail.extensions.interactiveHtml : null;
  const save = async () => {
    if (!detail)
      return;
    if (!detail.name.trim()) {
      setError(t2("characters.detail.nameRequired"));
      return;
    }
    await runAsync(setBusy, setError, async () => {
      const r = await remote.saveCharacter({
        cardId,
        name: detail.name,
        description: detail.description,
        personality: detail.personality,
        scenario: detail.scenario,
        firstMes: detail.firstMes,
        alternateGreetings: detail.alternateGreetings.map((s) => s.trim()).filter(Boolean),
        mesExample: detail.mesExample,
        systemPrompt: detail.systemPrompt,
        postHistoryInstructions: detail.postHistoryInstructions,
        creatorNotes: detail.creatorNotes,
        creator: detail.creator,
        characterVersion: detail.characterVersion,
        tags: detail.tags,
        depthPrompt: detail.depthPrompt ?? null
      });
      const err = errOf(r);
      if (err)
        setError(err);
      else {
        toast.show(t2("characters.detail.saved", { name: detail.name }));
        invalidateCharacter(cardId);
        reload();
        props.onSaved();
      }
    });
  };
  const exportCard = async (kind) => {
    await runAsync(setBusy, setError, async () => {
      const r = await remote.exportCharacter({ cardId });
      if (!r.ok) {
        setError(r.error.message);
        return;
      }
      if (kind === "json")
        downloadJson(`${r.value.name}.json`, r.value.json);
      else
        downloadBase64(`${r.value.name}.png`, r.value.pngBase64, "image/png");
      toast.show(t2("characters.detail.exported", { kind: kind.toUpperCase() }));
    });
  };
  return (0, import_jsx_runtime9.jsxs)(Dialog, { open: true, width: "xl", title: t2("characters.detail.title", { name: detail?.name ?? cardId }), onClose: props.onClose, children: [toast.node, state.status === "loading" && (0, import_jsx_runtime9.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: [(0, import_jsx_runtime9.jsx)(Skeleton, { height: 48 }), (0, import_jsx_runtime9.jsx)(Skeleton, { height: 14, width: "60%" }), (0, import_jsx_runtime9.jsx)(Skeleton, { height: 90 })] }), state.status === "error" && (0, import_jsx_runtime9.jsx)(Err, { message: state.message }), detail && (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-dialogStack dsh-tavern-scroll", style: { maxHeight: "65vh", overflow: "auto", fontSize: 13 }, children: [(0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-panelCard", style: { flexDirection: "row", alignItems: "center", gap: 14 }, children: [(0, import_jsx_runtime9.jsx)(CardAvatar, { remote, cardId, name: detail.name, size: 52 }), (0, import_jsx_runtime9.jsxs)("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }, children: [(0, import_jsx_runtime9.jsx)(Field, { label: t2("characters.detail.displayName"), children: (0, import_jsx_runtime9.jsx)("input", { className: "dsh-tavern-input", style: { width: "100%" }, value: detail.name, onChange: (e) => set({ name: e.target.value }) }) }), (0, import_jsx_runtime9.jsxs)(Muted, { children: [detail.spec, " \xB7 v", detail.characterVersion || "?", " \xB7 ", detail.creator || t2("characters.detail.unknownCreator"), detail.hasCharacterBook ? ` \xB7 ${detail.characterBookName ? t2("characters.card.embeddedBookNamed", { name: detail.characterBookName }) : t2("characters.card.embeddedBook")}` : ""] })] })] }), (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-panelCard", children: [(0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("characters.detail.groupPersona") }), (0, import_jsx_runtime9.jsx)(LabeledArea, { label: t2("characters.detail.description"), minHeight: 88, value: detail.description, onChange: (v) => set({ description: v }) }), (0, import_jsx_runtime9.jsx)(LabeledArea, { label: t2("characters.detail.personality"), value: detail.personality, onChange: (v) => set({ personality: v }) }), (0, import_jsx_runtime9.jsx)(LabeledArea, { label: t2("characters.detail.scenario"), value: detail.scenario, onChange: (v) => set({ scenario: v }) })] }), (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-panelCard", children: [(0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("characters.detail.groupGreetings") }), (0, import_jsx_runtime9.jsx)(LabeledArea, { label: t2("characters.detail.greeting"), minHeight: 88, value: detail.firstMes, onChange: (v) => set({ firstMes: v }) }), (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime9.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("characters.detail.altGreetings") }), (0, import_jsx_runtime9.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 72 }, value: detail.alternateGreetings.join("\n"), onChange: (e) => set({ alternateGreetings: e.target.value.split("\n") }) })] }), (0, import_jsx_runtime9.jsx)(LabeledArea, { label: t2("characters.detail.mesExample"), value: detail.mesExample, onChange: (v) => set({ mesExample: v }) })] }), (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-panelCard", children: [(0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("characters.detail.groupAdvanced") }), (0, import_jsx_runtime9.jsx)(LabeledArea, { label: t2("characters.detail.systemPrompt"), value: detail.systemPrompt, onChange: (v) => set({ systemPrompt: v }) }), (0, import_jsx_runtime9.jsx)(LabeledArea, { label: t2("characters.detail.postHistory"), value: detail.postHistoryInstructions, onChange: (v) => set({ postHistoryInstructions: v }) }), (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime9.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("characters.detail.depthPrompt") }), (0, import_jsx_runtime9.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 64 }, value: detail.depthPrompt?.prompt ?? "", onChange: (e) => set({
    depthPrompt: e.target.value.trim() ? { prompt: e.target.value, depth: detail.depthPrompt?.depth ?? 4, role: detail.depthPrompt?.role ?? "system" } : null
  }) }), detail.depthPrompt ? (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-fieldRow", style: { marginTop: 6 }, children: [(0, import_jsx_runtime9.jsx)(Field, { label: t2("characters.detail.depth"), children: (0, import_jsx_runtime9.jsx)(NumInput, { value: detail.depthPrompt.depth, onChange: (depth) => set({ depthPrompt: { ...detail.depthPrompt, depth: Math.max(0, Math.round(depth)) } }) }) }), (0, import_jsx_runtime9.jsx)(Field, { label: t2("characters.detail.role"), children: (0, import_jsx_runtime9.jsx)(Select, { value: detail.depthPrompt.role, onChange: (role) => set({ depthPrompt: { ...detail.depthPrompt, role } }), options: [
    { value: "system", label: "system" },
    { value: "user", label: "user" },
    { value: "assistant", label: "assistant" }
  ] }) })] }) : null] })] }), (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-panelCard", children: [(0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("characters.detail.groupMetadata") }), (0, import_jsx_runtime9.jsx)(LabeledArea, { label: t2("characters.detail.creatorNotes"), value: detail.creatorNotes, onChange: (v) => set({ creatorNotes: v }) }), (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-fieldRow", children: [(0, import_jsx_runtime9.jsx)(Field, { label: t2("characters.detail.creator"), children: (0, import_jsx_runtime9.jsx)("input", { className: "dsh-tavern-input", value: detail.creator, onChange: (e) => set({ creator: e.target.value }) }) }), (0, import_jsx_runtime9.jsx)(Field, { label: t2("characters.detail.version"), children: (0, import_jsx_runtime9.jsx)("input", { className: "dsh-tavern-input", value: detail.characterVersion, onChange: (e) => set({ characterVersion: e.target.value }) }) })] }), (0, import_jsx_runtime9.jsx)(Field, { label: t2("characters.detail.tags"), children: (0, import_jsx_runtime9.jsx)("input", { className: "dsh-tavern-input", style: { width: "100%" }, value: detail.tags.join(", "), onChange: (e) => set({ tags: e.target.value.split(/[，,]/).map((s) => s.trim()).filter(Boolean) }) }) })] }), (0, import_jsx_runtime9.jsx)(Err, { message: error }), (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-footActions", style: { marginTop: 2 }, children: [(0, import_jsx_runtime9.jsx)(IconBtn, { label: t2("characters.detail.exportPng"), disabled: busy, onClick: () => void exportCard("png"), children: (0, import_jsx_runtime9.jsx)(import_dsh_client_ui_primitives9.IconDownloadOutline16, {}) }), interactiveHtml !== null && (0, import_jsx_runtime9.jsx)(Btn, { size: "md", onClick: () => setCardOpen(true), children: t2("interactive.open") }), (0, import_jsx_runtime9.jsx)("span", { className: "dsh-tavern-footSpacer" }), (0, import_jsx_runtime9.jsx)(Btn, { size: "md", disabled: busy, onClick: () => void exportCard("json"), children: t2("characters.detail.exportJson") }), (0, import_jsx_runtime9.jsx)(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void save(), children: t2("action.save") })] })] }), cardOpen && interactiveHtml !== null && (0, import_jsx_runtime9.jsx)(Dialog, { open: true, width: "lg", title: t2("characters.detail.interactiveTitle", { name: detail?.name ?? "" }), onClose: () => setCardOpen(false), children: (0, import_jsx_runtime9.jsx)("iframe", { sandbox: "allow-scripts", srcDoc: withCsp(interactiveHtml), title: t2("characters.detail.interactiveFrame"), style: { width: "100%", height: "60vh", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))", borderRadius: 16, background: "var(--dsw-alias-bg-base, #111)" } }) })] });
}
function CharactersSection(props) {
  const { remote } = props;
  const t2 = useT();
  const { state, reload } = useLoader(() => remote.listCharacters({}), []);
  const [error, setError] = (0, import_react9.useState)(null);
  const [busy, setBusy] = (0, import_react9.useState)(false);
  const [detailId, setDetailId] = (0, import_react9.useState)(null);
  const [pending, setPending] = (0, import_react9.useState)(null);
  const [toDelete, setToDelete] = (0, import_react9.useState)(null);
  const [creating, setCreating] = (0, import_react9.useState)(false);
  const [newName, setNewName] = (0, import_react9.useState)("");
  const [query, setQuery] = (0, import_react9.useState)("");
  const toast = useToast();
  const doImport = async (name2, dataBase64, importWorldBook) => {
    setBusy(true);
    setError(null);
    try {
      const r = await remote.importCharacter({ name: name2, dataBase64, importWorldBook });
      const err = errOf(r);
      if (err)
        setError(err);
      else {
        toast.show(t2(importWorldBook ? "characters.importedWithBook" : "characters.imported"));
        reload();
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };
  const onImportFile = async (file) => {
    setBusy(true);
    setError(null);
    try {
      const dataBase64 = await fileToBase64(file);
      const inspected = await remote.inspectCharacter({ name: file.name, dataBase64 });
      if (!inspected.ok) {
        setError(inspected.error.message);
        return;
      }
      if (inspected.value.hasCharacterBook) {
        setPending({ name: file.name, dataBase64, preview: inspected.value });
        return;
      }
      await doImport(file.name, dataBase64, false);
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2));
    } finally {
      setBusy(false);
    }
  };
  const onDelete = async () => {
    if (!toDelete)
      return;
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deleteCharacter({ cardId: toDelete.cardId });
      const err = errOf(r);
      if (err)
        setError(err);
      else {
        toast.show(r.ok && r.value.salvagedLorebook ? t2("characters.deletedSalvaged", { name: toDelete.name, book: r.value.salvagedLorebook }) : t2("characters.deleted", { name: toDelete.name }));
        invalidateCharacter(toDelete.cardId);
        setToDelete(null);
        reload();
      }
    });
  };
  const items = state.status === "ready" ? state.value.items : [];
  const q = query.trim().toLowerCase();
  const filtered = q === "" ? items : items.filter((c) => c.name.toLowerCase().includes(q) || (c.characterBookName ?? "").toLowerCase().includes(q));
  return (0, import_jsx_runtime9.jsxs)(Section, { title: t2("section.characters"), description: t2("characters.section.desc"), children: [toast.node, (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-toolbar", children: [(0, import_jsx_runtime9.jsx)(FileBtn, { accept: ".png,.json", disabled: busy, onFile: (file) => void onImportFile(file), children: t2("characters.importFile") }), (0, import_jsx_runtime9.jsx)(Btn, { size: "md", disabled: busy, onClick: () => setCreating(true), children: t2("characters.newCard") }), (0, import_jsx_runtime9.jsx)(Btn, { size: "md", onClick: reload, disabled: busy, children: t2("action.refresh") }), items.length >= 5 && (0, import_jsx_runtime9.jsx)(SearchInput, { label: t2("characters.searchLabel"), value: query, onChange: setQuery, placeholder: t2("characters.searchPlaceholder"), width: 220 })] }), state.status === "loading" && (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-charGrid", children: [(0, import_jsx_runtime9.jsx)(Skeleton, { height: 198, radius: 18 }), (0, import_jsx_runtime9.jsx)(Skeleton, { height: 198, radius: 18 }), (0, import_jsx_runtime9.jsx)(Skeleton, { height: 198, radius: 18 })] }), state.status === "error" && (0, import_jsx_runtime9.jsx)(Err, { message: state.message }), (0, import_jsx_runtime9.jsx)(Err, { message: error }), items.length === 0 && state.status === "ready" && (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-empty", children: [(0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-emptyIcon", children: (0, import_jsx_runtime9.jsx)(import_dsh_client_ui_primitives9.IconUserOutline16, { size: 32 }) }), (0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-emptyTitle", children: t2("hero.noCharacters") }), (0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-emptyDesc", children: t2("characters.emptyDesc") })] }), q !== "" && filtered.length === 0 && state.status === "ready" && (0, import_jsx_runtime9.jsx)(SearchEmpty, { what: t2("characters.what"), query: query.trim(), onClear: () => setQuery("") }), (0, import_jsx_runtime9.jsx)("div", { className: "dsh-tavern-charGrid", children: filtered.map((item) => (0, import_jsx_runtime9.jsx)(CharacterCard, { remote, item, busy, onOpen: setDetailId, onDelete: setToDelete }, item.cardId)) }), detailId && (0, import_jsx_runtime9.jsx)(CharacterDetailDialog, { remote, cardId: detailId, onClose: () => setDetailId(null), onSaved: reload }), pending && (0, import_jsx_runtime9.jsx)(Dialog, { open: true, title: t2("characters.importBook.title"), description: pending.preview.characterBookName ? t2("characters.importBook.descNamed", { name: pending.preview.name, book: pending.preview.characterBookName, count: pending.preview.entryCount }) : t2("characters.importBook.desc", { name: pending.preview.name, count: pending.preview.entryCount }), onClose: () => setPending(null), footer: (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-modalActions", children: [(0, import_jsx_runtime9.jsx)(import_dsh_client_ui_primitives9.Button, { type: "button", variant: "outline", size: "md", disabled: busy, onClick: () => void doImport(pending.name, pending.dataBase64, false), children: t2("characters.importBook.skip") }), (0, import_jsx_runtime9.jsx)(import_dsh_client_ui_primitives9.Button, { type: "button", variant: "primary", size: "md", disabled: busy, onClick: () => void doImport(pending.name, pending.dataBase64, true), children: t2("characters.importBook.import") })] }), children: (0, import_jsx_runtime9.jsx)("p", { style: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" }, children: t2("characters.importBook.skipNote") }) }), (0, import_jsx_runtime9.jsx)(ConfirmDialog, { open: toDelete !== null, title: t2("characters.delete.title"), description: toDelete ? t2("characters.delete.desc", { name: toDelete.name }) : "", confirmLabel: t2("action.delete"), danger: true, busy, onCancel: () => setToDelete(null), onConfirm: () => void onDelete() }), (0, import_jsx_runtime9.jsx)(Dialog, { open: creating, title: t2("characters.create.title"), description: t2("characters.create.desc"), onClose: () => setCreating(false), footer: (0, import_jsx_runtime9.jsxs)("div", { className: "dsh-tavern-modalActions", children: [(0, import_jsx_runtime9.jsx)(Btn, { size: "md", onClick: () => setCreating(false), children: t2("action.cancel") }), (0, import_jsx_runtime9.jsx)(Btn, { primary: true, size: "md", disabled: busy || !newName.trim(), onClick: () => {
    void runAsync(setBusy, setError, async () => {
      const r = await remote.createCharacter({ name: newName.trim() });
      const err = errOf(r);
      if (err)
        setError(err);
      else {
        toast.show(t2("characters.created", { name: r.ok ? r.value.name : newName }));
        setCreating(false);
        setNewName("");
        reload();
        if (r.ok)
          setDetailId(r.value.cardId);
      }
    });
  }, children: t2("characters.create.confirm") })] }), children: (0, import_jsx_runtime9.jsx)("input", { className: "dsh-tavern-input", style: { width: "100%", height: 36, borderRadius: 8, padding: "0 10px", fontSize: 13, boxSizing: "border-box" }, value: newName, placeholder: t2("characters.create.namePlaceholder"), onChange: (e) => setNewName(e.target.value) }) })] });
}

// lib/client/panel/lorebooks.js
var import_jsx_runtime10 = require("react/jsx-runtime");
var import_react10 = require("react");
var import_dsh_client_ui_primitives10 = require("@deepseek-ai/dsh-client-ui-primitives");
function LorebooksSection(props) {
  const { remote } = props;
  const { state, reload } = useLoader(() => remote.listLorebooks({}), []);
  const chars = useLoader(() => remote.listCharacters({}), []);
  const [error, setError] = (0, import_react10.useState)(null);
  const [busy, setBusy] = (0, import_react10.useState)(false);
  const [opening, setOpening] = (0, import_react10.useState)(false);
  const [opened, setOpened] = (0, import_react10.useState)(null);
  const [toDelete, setToDelete] = (0, import_react10.useState)(null);
  const [toDeleteEmbedded, setToDeleteEmbedded] = (0, import_react10.useState)(null);
  const [creating, setCreating] = (0, import_react10.useState)(false);
  const [newName, setNewName] = (0, import_react10.useState)("");
  const toast = useToast();
  const t2 = useT();
  const names = state.status === "ready" ? state.value.items : [];
  const charItems = chars.state.status === "ready" ? chars.state.value.items : [];
  const charBooks = charItems.filter((c) => c.hasCharacterBook);
  const [query, setQuery] = (0, import_react10.useState)("");
  const q = query.trim().toLowerCase();
  const matchBook = (label) => q === "" || label.toLowerCase().includes(q);
  const shownCharBooks = q === "" ? charBooks : charBooks.filter((c) => matchBook(c.characterBookName || c.name) || c.name.toLowerCase().includes(q));
  const shownNames = q === "" ? names : names.filter(matchBook);
  const totalBooks = charBooks.length + names.length;
  const openLibrary = async (name2) => {
    setError(null);
    setOpening(true);
    try {
      const r = await remote.getLorebook({ name: name2 });
      if (!r.ok) {
        setError(r.error.message);
        return;
      }
      setOpened({
        target: { kind: "library", name: name2 },
        entries: parseLorebook(r.value.json, { source: "global", sourceRef: name2 })
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };
  const openCharacter = async (item) => {
    setError(null);
    setOpening(true);
    try {
      const r = await remote.getCharacterLorebook({ cardId: item.cardId });
      if (!r.ok) {
        setError(r.error.message);
        return;
      }
      setOpened({
        target: { kind: "character", cardId: item.cardId, name: r.value.name },
        entries: parseLorebook(r.value.json, { source: "character", sourceRef: item.cardId })
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };
  const remove = async () => {
    if (!toDelete)
      return;
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deleteLorebook({ name: toDelete });
      const err = errOf(r);
      if (err)
        setError(err);
      else {
        if (opened?.target.kind === "library" && opened.target.name === toDelete)
          setOpened(null);
        setToDelete(null);
        reload();
      }
    });
  };
  const removeEmbedded = async () => {
    const target = toDeleteEmbedded;
    if (!target)
      return;
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deleteEmbeddedLorebook({ cardId: target.cardId });
      const err = errOf(r);
      if (err)
        setError(err);
      else {
        toast.show(t2("lorebooks.embeddedDeleted", { name: target.name }));
        setToDeleteEmbedded(null);
        chars.reload();
      }
    });
  };
  const exportBook = async (name2) => {
    await runAsync(setBusy, setError, async () => {
      const r = await remote.getLorebook({ name: name2 });
      if (!r.ok)
        setError(r.error.message);
      else
        downloadJson(`${name2}.json`, r.value.json);
    });
  };
  const onImportFile = async (file) => {
    setBusy(true);
    setError(null);
    try {
      const json = await readJsonFile(file);
      const name2 = file.name.replace(/\.json$/i, "");
      const r = await remote.importLorebook({ name: name2, json });
      if (!r.ok)
        setError(r.error.message);
      else {
        toast.show(t2("lorebooks.imported", { name: r.value.name, count: r.value.entryCount }));
        reload();
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2));
    } finally {
      setBusy(false);
    }
  };
  const createEmpty = async () => {
    const name2 = newName.trim();
    if (!name2) {
      setError(t2("lorebooks.nameRequired"));
      return;
    }
    await runAsync(setBusy, setError, async () => {
      const r = await remote.importLorebook({ name: name2, json: { entries: {} } });
      if (!r.ok) {
        setError(r.error.message);
        return;
      }
      setCreating(false);
      setNewName("");
      reload();
      await openLibrary(r.value.name);
    });
  };
  if (opened) {
    return (0, import_jsx_runtime10.jsxs)(Section, { title: t2("section.lorebooks"), description: t2("lorebooks.editorDesc"), children: [toast.node, (0, import_jsx_runtime10.jsx)(LorebookEditor, { target: opened.target, entries: opened.entries, onClose: () => setOpened(null), onSaved: () => {
      toast.show(t2("lorebooks.saved", { name: opened.target.name }));
      chars.reload();
      reload();
    }, save: (json) => opened.target.kind === "library" ? remote.saveLorebook({ name: opened.target.name, json }) : remote.saveCharacterLorebook({ cardId: opened.target.cardId, json }) })] });
  }
  return (0, import_jsx_runtime10.jsxs)(Section, { title: t2("section.lorebooks"), description: t2("lorebooks.listDesc"), children: [toast.node, (0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-toolbar", children: [(0, import_jsx_runtime10.jsx)(FileBtn, { accept: ".json", disabled: busy, onFile: (file) => void onImportFile(file), children: t2("lorebooks.importJson") }), (0, import_jsx_runtime10.jsx)(Btn, { size: "md", disabled: busy, onClick: () => setCreating(true), children: t2("lorebooks.newEmpty") }), (0, import_jsx_runtime10.jsx)(Btn, { size: "md", onClick: () => {
    reload();
    chars.reload();
  }, disabled: busy, children: t2("action.refresh") }), totalBooks >= 5 && (0, import_jsx_runtime10.jsx)(SearchInput, { label: t2("lorebooks.searchLabel"), value: query, onChange: setQuery, placeholder: t2("lorebooks.searchPlaceholder"), width: 220 })] }), (state.status === "loading" || opening) && (0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-list", children: [(0, import_jsx_runtime10.jsx)(Skeleton, { height: 70, radius: 16 }), (0, import_jsx_runtime10.jsx)(Skeleton, { height: 70, radius: 16 }), (0, import_jsx_runtime10.jsx)(Skeleton, { height: 70, radius: 16 })] }), state.status === "error" && (0, import_jsx_runtime10.jsx)(Err, { message: state.message }), (0, import_jsx_runtime10.jsx)(Err, { message: error }), q !== "" && shownCharBooks.length === 0 && shownNames.length === 0 && state.status === "ready" && chars.state.status === "ready" && (0, import_jsx_runtime10.jsx)(SearchEmpty, { what: t2("section.lorebooks"), query: query.trim(), onClear: () => setQuery("") }), shownCharBooks.length > 0 && (0, import_jsx_runtime10.jsxs)(import_jsx_runtime10.Fragment, { children: [(0, import_jsx_runtime10.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("lorebooks.groupEmbedded") }), (0, import_jsx_runtime10.jsx)("div", { className: "dsh-tavern-list", children: shownCharBooks.map((item) => (0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-tile", ...clickableProps(() => void openCharacter(item)), children: [(0, import_jsx_runtime10.jsx)("span", { className: "dsh-tavern-tileIcon", children: (0, import_jsx_runtime10.jsx)(import_dsh_client_ui_primitives10.IconFolderOpenOutline16, { size: 18 }) }), (0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-tileMain", children: [(0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-tileTitleRow", children: [(0, import_jsx_runtime10.jsx)("span", { className: "dsh-tavern-tileName", children: item.characterBookName || item.name }), (0, import_jsx_runtime10.jsx)(Badge, { children: t2("lorebooks.badgeEmbedded") })] }), (0, import_jsx_runtime10.jsx)("span", { className: "dsh-tavern-tileSub", children: typeof item.characterBookEntryCount === "number" && item.characterBookEntryCount > 0 ? t2("lorebooks.fromCharacterWithCount", { name: item.name, count: item.characterBookEntryCount }) : t2("lorebooks.fromCharacter", { name: item.name }) })] }), (0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-tileActions", children: [(0, import_jsx_runtime10.jsx)(IconBtn, { label: t2("lorebooks.editEntries"), onClick: () => void openCharacter(item), children: (0, import_jsx_runtime10.jsx)(import_dsh_client_ui_primitives10.IconEditOutline16, {}) }), (0, import_jsx_runtime10.jsx)(IconBtn, { label: t2("lorebooks.deleteEmbedded"), danger: true, onClick: () => setToDeleteEmbedded(item), children: (0, import_jsx_runtime10.jsx)(import_dsh_client_ui_primitives10.IconTrashOutline16, {}) })] })] }, item.cardId)) })] }), (0, import_jsx_runtime10.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("lorebooks.groupLibrary") }), shownNames.length === 0 && state.status === "ready" ? q === "" ? (0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-empty", children: [(0, import_jsx_runtime10.jsx)("div", { className: "dsh-tavern-emptyIcon", children: (0, import_jsx_runtime10.jsx)(import_dsh_client_ui_primitives10.IconFolderOpenOutline16, { size: 32 }) }), (0, import_jsx_runtime10.jsx)("div", { className: "dsh-tavern-emptyTitle", children: t2("lorebooks.emptyTitle") }), (0, import_jsx_runtime10.jsx)("div", { className: "dsh-tavern-emptyDesc", children: charBooks.length > 0 ? t2("lorebooks.emptyDescEmbeddedAbove") : t2("lorebooks.emptyDesc") })] }) : null : (0, import_jsx_runtime10.jsx)("div", { className: "dsh-tavern-list", children: shownNames.map((name2) => (0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-tile", ...clickableProps(() => void openLibrary(name2)), children: [(0, import_jsx_runtime10.jsx)("span", { className: "dsh-tavern-tileIcon", children: (0, import_jsx_runtime10.jsx)(import_dsh_client_ui_primitives10.IconFolderOpenOutline16, { size: 18 }) }), (0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-tileMain", children: [(0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-tileTitleRow", children: [(0, import_jsx_runtime10.jsx)("span", { className: "dsh-tavern-tileName", children: name2 }), (0, import_jsx_runtime10.jsx)(Badge, { children: t2("lorebooks.badgeLibrary") })] }), (0, import_jsx_runtime10.jsx)("span", { className: "dsh-tavern-tileSub", children: t2("lorebooks.libraryFileSub") })] }), (0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-tileActions", children: [(0, import_jsx_runtime10.jsx)(IconBtn, { label: t2("lorebooks.editEntries"), onClick: () => void openLibrary(name2), children: (0, import_jsx_runtime10.jsx)(import_dsh_client_ui_primitives10.IconEditOutline16, {}) }), (0, import_jsx_runtime10.jsx)(IconBtn, { label: t2("lorebooks.exportJson"), disabled: busy, onClick: () => void exportBook(name2), children: (0, import_jsx_runtime10.jsx)(import_dsh_client_ui_primitives10.IconDownloadOutline16, {}) }), (0, import_jsx_runtime10.jsx)(IconBtn, { label: t2("lorebooks.deleteBook"), danger: true, onClick: () => setToDelete(name2), children: (0, import_jsx_runtime10.jsx)(import_dsh_client_ui_primitives10.IconTrashOutline16, {}) })] })] }, name2)) }), (0, import_jsx_runtime10.jsx)(ConfirmDialog, { open: toDelete !== null, title: t2("lorebooks.confirmDeleteTitle"), description: toDelete ? t2("lorebooks.confirmDeleteDesc", { name: toDelete }) : "", confirmLabel: t2("action.delete"), danger: true, busy, onCancel: () => setToDelete(null), onConfirm: () => void remove() }), (0, import_jsx_runtime10.jsx)(ConfirmDialog, { open: toDeleteEmbedded !== null, title: t2("lorebooks.confirmDeleteEmbeddedTitle"), description: toDeleteEmbedded ? t2("lorebooks.confirmDeleteEmbeddedDesc", {
    name: toDeleteEmbedded.name,
    book: toDeleteEmbedded.characterBookName ? t2("lorebooks.bookNameSuffix", { name: toDeleteEmbedded.characterBookName }) : ""
  }) : "", confirmLabel: t2("action.delete"), danger: true, busy, onCancel: () => setToDeleteEmbedded(null), onConfirm: () => void removeEmbedded() }), (0, import_jsx_runtime10.jsx)(Dialog, { open: creating, title: t2("lorebooks.createTitle"), description: t2("lorebooks.createDesc"), onClose: () => setCreating(false), footer: (0, import_jsx_runtime10.jsxs)("div", { className: "dsh-tavern-modalActions", children: [(0, import_jsx_runtime10.jsx)(Btn, { size: "md", onClick: () => setCreating(false), children: t2("action.cancel") }), (0, import_jsx_runtime10.jsx)(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void createEmpty(), children: t2("lorebooks.create") })] }), children: (0, import_jsx_runtime10.jsx)("input", { className: "dsh-tavern-input", style: { width: "100%", height: 36, borderRadius: 8, padding: "0 10px", fontSize: 13, boxSizing: "border-box" }, value: newName, placeholder: t2("lorebooks.namePlaceholder"), onChange: (e) => setNewName(e.target.value) }) })] });
}

// lib/client/panel/memory.js
var import_jsx_runtime11 = require("react/jsx-runtime");
var import_react11 = require("react");
var import_dsh_client_ui_primitives11 = require("@deepseek-ai/dsh-client-ui-primitives");
var DELTA_TYPE_KEY = { add: "memory.deltaType.add", update: "memory.deltaType.update", invalidate: "memory.deltaType.invalidate" };
function splitList(text) {
  return text.split(/[，,\n]/).map((s) => s.trim()).filter(Boolean);
}
function MemoryEditor(props) {
  const { entry } = props;
  const t2 = useT();
  const [body, setBody] = (0, import_react11.useState)(entry.body);
  const [tags, setTags] = (0, import_react11.useState)(entry.tags.join(", "));
  const [keys, setKeys] = (0, import_react11.useState)(entry.keys.join(", "));
  const [error, setError] = (0, import_react11.useState)(null);
  const [busy, setBusy] = (0, import_react11.useState)(false);
  const save = () => runAsync(setBusy, setError, async () => {
    const r = await props.remote.saveMemory({
      cardId: props.cardId,
      storyId: props.storyId,
      id: entry.id,
      body,
      tags: splitList(tags),
      keys: splitList(keys)
    });
    const err = errOf(r);
    if (err)
      setError(err);
    else
      props.onDone();
  });
  return (0, import_jsx_runtime11.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }, children: [(0, import_jsx_runtime11.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", value: body, onChange: (e) => setBody(e.target.value) }), (0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-fieldRow", children: [(0, import_jsx_runtime11.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime11.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("memory.tags") }), (0, import_jsx_runtime11.jsx)("input", { className: "dsh-tavern-input", value: tags, onChange: (e) => setTags(e.target.value) })] }), (0, import_jsx_runtime11.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime11.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("memory.keys") }), (0, import_jsx_runtime11.jsx)("input", { className: "dsh-tavern-input", value: keys, onChange: (e) => setKeys(e.target.value) })] })] }), (0, import_jsx_runtime11.jsx)(Err, { message: error }), (0, import_jsx_runtime11.jsxs)("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" }, children: [(0, import_jsx_runtime11.jsx)(Btn, { onClick: props.onDone, children: t2("action.cancel") }), (0, import_jsx_runtime11.jsx)(Btn, { primary: true, disabled: busy || !body.trim(), onClick: () => void save(), children: t2("action.save") })] })] });
}
function MemorySection(props) {
  const { remote } = props;
  const t2 = useT();
  const chars = useLoader(() => remote.listCharacters({}), []);
  const [cardId, setCardId] = (0, import_react11.useState)("");
  const [storyId, setStoryId] = (0, import_react11.useState)(void 0);
  const stories = useLoader(() => remote.listStories({ cardId }), [cardId], cardId !== "");
  const [tab, setTab] = (0, import_react11.useState)("memory");
  const [error, setError] = (0, import_react11.useState)(null);
  const [busy, setBusy] = (0, import_react11.useState)(false);
  const [editingId, setEditingId] = (0, import_react11.useState)(null);
  const [newBody, setNewBody] = (0, import_react11.useState)("");
  const [journalText, setJournalText] = (0, import_react11.useState)("");
  const [deltaType, setDeltaType] = (0, import_react11.useState)("add");
  const [deltaContent, setDeltaContent] = (0, import_react11.useState)("");
  const [deltaRef, setDeltaRef] = (0, import_react11.useState)("");
  const [deltaKeys, setDeltaKeys] = (0, import_react11.useState)("");
  const toast = useToast();
  const memories = useLoader(() => remote.getMemories({ cardId, storyId }), [cardId, storyId], cardId !== "");
  const deltas = useLoader(() => remote.getWorldDeltas({ cardId, storyId }), [cardId, storyId], cardId !== "");
  const journal = useLoader(() => remote.getJournal({ cardId, storyId }), [cardId, storyId], cardId !== "");
  const op = (fn) => runAsync(setBusy, setError, fn, (message) => toast.show(t2("memory.opFailed", { message })));
  const charItems = chars.state.status === "ready" ? chars.state.value.items : [];
  const memoryItems = memories.state.status === "ready" ? memories.state.value.items : [];
  const deltaItems = deltas.state.status === "ready" ? deltas.state.value.items : [];
  (0, import_react11.useEffect)(() => {
    setJournalText("");
    setEditingId(null);
    setNewBody("");
    setDeltaContent("");
  }, [cardId, storyId]);
  (0, import_react11.useEffect)(() => {
    if (journal.state.status === "ready")
      setJournalText(journal.state.value.text);
  }, [journal.state]);
  const addMemory = () => op(async () => {
    const r = await remote.saveMemory({ cardId, storyId, body: newBody.trim() });
    const err = errOf(r);
    if (err)
      setError(err);
    else {
      setNewBody("");
      memories.reload();
    }
  });
  const deleteMemory = (id) => op(async () => {
    const r = await remote.deleteMemory({ cardId, storyId, id });
    const err = errOf(r);
    if (err)
      setError(err);
    else
      memories.reload();
  });
  const compress = () => op(async () => {
    const r = await remote.compressMemories({ cardId, storyId });
    if (!r.ok)
      setError(r.error.message);
    else {
      toast.show(r.value.merged > 0 ? t2("memory.compressed", { count: r.value.merged }) : t2("memory.compressNoop"));
      memories.reload();
    }
  });
  const revoke = (id) => op(async () => {
    const r = await remote.revokeWorldDelta({ cardId, storyId, id });
    const err = errOf(r);
    if (err)
      setError(err);
    else {
      toast.show(t2("memory.revokeDone", { id }));
      deltas.reload();
    }
  });
  const exportBook = () => op(async () => {
    const r = await remote.exportMergedLorebook({ cardId, storyId });
    if (!r.ok)
      setError(r.error.message);
    else {
      downloadJson(`lorebook-merged-${cardId}.json`, r.value.json);
      toast.show(t2("memory.bookExported"));
    }
  });
  const saveJournal = () => op(async () => {
    const r = await remote.saveJournal({ cardId, storyId, text: journalText });
    const err = errOf(r);
    if (err)
      setError(err);
    else {
      toast.show(t2("memory.journalSaved"));
      journal.reload();
    }
  });
  const addDelta = () => op(async () => {
    const r = await remote.addWorldDelta({
      cardId,
      storyId,
      type: deltaType,
      content: deltaContent.trim(),
      ref: deltaRef.trim() || null,
      keys: splitList(deltaKeys)
    });
    const err = errOf(r);
    if (err)
      setError(err);
    else {
      toast.show(t2("memory.deltaAdded", { id: r.ok ? r.value.id : "" }));
      setDeltaContent("");
      setDeltaRef("");
      setDeltaKeys("");
      deltas.reload();
    }
  });
  return (0, import_jsx_runtime11.jsxs)(Section, { title: t2("section.memory"), description: t2("memory.desc"), children: [toast.node, (0, import_jsx_runtime11.jsx)(SettingsRow, { title: t2("memory.character"), description: t2("memory.characterDesc"), children: (0, import_jsx_runtime11.jsx)(Select, { size: "md", value: cardId, disabled: busy, onChange: (value) => {
    setStoryId(void 0);
    setCardId(value);
  }, options: [{ value: "", label: t2("memory.pickCharacter") }, ...charItems.map((c) => ({ value: c.cardId, label: c.name }))] }) }), cardId && (0, import_jsx_runtime11.jsx)(SettingsRow, { title: t2("memory.story"), description: t2("memory.storyDesc"), children: (0, import_jsx_runtime11.jsx)(Select, { value: storyId ?? "", disabled: busy, onChange: (value) => setStoryId(value || void 0), options: [{ value: "", label: t2("memory.initialState") }, ...stories.state.status === "ready" ? stories.state.value.items.map((story) => ({ value: story.id, label: `${story.sessionId} \xB7 ${story.createdAt.slice(0, 10)}` })) : []] }) }), (0, import_jsx_runtime11.jsx)(Err, { message: stories.state.status === "error" ? stories.state.message : error }), cardId && (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [(0, import_jsx_runtime11.jsxs)("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, margin: "10px 0 14px" }, children: [(0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-filters", children: [(0, import_jsx_runtime11.jsx)("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === "memory" ? "true" : "false", onClick: () => setTab("memory"), children: t2("memory.tab.memory", { count: memoryItems.length }) }), (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === "delta" ? "true" : "false", onClick: () => setTab("delta"), children: t2("memory.tab.delta", { count: deltaItems.length }) }), (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === "journal" ? "true" : "false", onClick: () => setTab("journal"), children: t2("memory.tab.journal") })] }), (0, import_jsx_runtime11.jsx)("span", { style: { flex: 1 } }), tab === "memory" && (0, import_jsx_runtime11.jsx)(Btn, { disabled: busy, onClick: () => void compress(), children: t2("memory.compressOldest") }), tab === "delta" && (0, import_jsx_runtime11.jsx)(Btn, { disabled: busy, onClick: () => void exportBook(), children: t2("memory.exportBook") })] }), tab === "memory" && (0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-list", children: [memories.state.status === "loading" && (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [(0, import_jsx_runtime11.jsx)(Skeleton, { height: 72 }), (0, import_jsx_runtime11.jsx)(Skeleton, { height: 72 }), (0, import_jsx_runtime11.jsx)(Skeleton, { height: 72 })] }), memories.state.status === "error" && (0, import_jsx_runtime11.jsx)(Err, { message: memories.state.message }), memoryItems.length === 0 && memories.state.status === "ready" && (0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-empty is-compact", children: [(0, import_jsx_runtime11.jsx)("div", { className: "dsh-tavern-emptyTitle", children: t2("memory.emptyMemories") }), (0, import_jsx_runtime11.jsx)("div", { className: "dsh-tavern-emptyDesc", children: t2("memory.emptyMemoriesDesc") })] }), memoryItems.map((m) => (0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-memo", children: [(0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-memoHead", children: [(0, import_jsx_runtime11.jsx)(Badge, { children: m.id }), m.archived ? (0, import_jsx_runtime11.jsx)(Badge, { children: t2("memory.archived") }) : null, m.tags.map((tag) => (0, import_jsx_runtime11.jsx)(Badge, { children: tag }, tag)), (0, import_jsx_runtime11.jsx)("span", { className: "dsh-tavern-memoMeta", children: m.updated }), (0, import_jsx_runtime11.jsxs)("span", { className: "dsh-tavern-memoActions", children: [(0, import_jsx_runtime11.jsx)(IconBtn, { label: editingId === m.id ? t2("memory.collapseEdit") : t2("action.edit"), onClick: () => setEditingId(editingId === m.id ? null : m.id), children: (0, import_jsx_runtime11.jsx)(import_dsh_client_ui_primitives11.IconEditOutline16, {}) }), (0, import_jsx_runtime11.jsx)(IconBtn, { label: t2("memory.deleteEntry"), danger: true, disabled: busy, onClick: () => void deleteMemory(m.id), children: (0, import_jsx_runtime11.jsx)(import_dsh_client_ui_primitives11.IconTrashOutline16, {}) })] })] }), (0, import_jsx_runtime11.jsx)("pre", { className: "dsh-tavern-memoBody dsh-tavern-scroll", children: m.body }), editingId === m.id && (0, import_jsx_runtime11.jsx)(MemoryEditor, { remote, cardId, storyId, entry: m, onDone: () => {
    setEditingId(null);
    memories.reload();
  } })] }, m.id)), (0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-memo is-compose", children: [(0, import_jsx_runtime11.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 60 }, placeholder: t2("memory.newPlaceholder"), value: newBody, onChange: (e) => setNewBody(e.target.value) }), (0, import_jsx_runtime11.jsx)("div", { style: { display: "flex", justifyContent: "flex-end" }, children: (0, import_jsx_runtime11.jsx)(Btn, { primary: true, disabled: busy || !newBody.trim(), onClick: () => void addMemory(), children: t2("memory.addEntry") }) })] })] }), tab === "delta" && (0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-list", children: [deltas.state.status === "loading" && (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [(0, import_jsx_runtime11.jsx)(Skeleton, { height: 72 }), (0, import_jsx_runtime11.jsx)(Skeleton, { height: 72 }), (0, import_jsx_runtime11.jsx)(Skeleton, { height: 72 })] }), deltas.state.status === "error" && (0, import_jsx_runtime11.jsx)(Err, { message: deltas.state.message }), deltaItems.map((d) => (0, import_jsx_runtime11.jsxs)("div", { className: `dsh-tavern-memo${d.revoked ? " is-revoked" : ""}`, children: [(0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-memoHead", children: [(0, import_jsx_runtime11.jsxs)(Badge, { children: ["#", d.id] }), (0, import_jsx_runtime11.jsx)(Badge, { danger: d.type === "invalidate", children: t2(DELTA_TYPE_KEY[d.type]) }), d.ref ? (0, import_jsx_runtime11.jsxs)(Badge, { children: ["\u2192 ", d.ref] }) : null, d.revoked ? (0, import_jsx_runtime11.jsx)(Badge, { danger: true, children: t2("memory.revoked") }) : null, (0, import_jsx_runtime11.jsx)("span", { className: "dsh-tavern-memoMeta", children: d.ts }), !d.revoked && (0, import_jsx_runtime11.jsx)("span", { className: "dsh-tavern-memoActions", children: (0, import_jsx_runtime11.jsx)(Btn, { size: "sm", disabled: busy, onClick: () => void revoke(d.id), children: t2("memory.revoke") }) })] }), (0, import_jsx_runtime11.jsx)("pre", { className: "dsh-tavern-memoBody dsh-tavern-scroll", children: d.content })] }, d.id)), deltaItems.length === 0 && deltas.state.status === "ready" && (0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-empty is-compact", children: [(0, import_jsx_runtime11.jsx)("div", { className: "dsh-tavern-emptyTitle", children: t2("memory.emptyDeltas") }), (0, import_jsx_runtime11.jsx)("div", { className: "dsh-tavern-emptyDesc", children: t2("memory.emptyDeltasDesc") })] }), (0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-memo is-compose", children: [(0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-fieldRow", children: [(0, import_jsx_runtime11.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime11.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("memory.deltaType") }), (0, import_jsx_runtime11.jsx)(Select, { size: "md", value: deltaType, onChange: (v) => setDeltaType(v), options: [
    { value: "add", label: t2(DELTA_TYPE_KEY.add) },
    { value: "update", label: t2(DELTA_TYPE_KEY.update) },
    { value: "invalidate", label: t2(DELTA_TYPE_KEY.invalidate) }
  ] })] }), (deltaType === "update" || deltaType === "invalidate") && (0, import_jsx_runtime11.jsxs)("label", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime11.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("memory.deltaRef") }), (0, import_jsx_runtime11.jsx)("input", { className: "dsh-tavern-input", value: deltaRef, onChange: (e) => setDeltaRef(e.target.value) })] })] }), (0, import_jsx_runtime11.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 60, marginTop: 8 }, placeholder: t2("memory.deltaBodyPlaceholder"), value: deltaContent, onChange: (e) => setDeltaContent(e.target.value) }), (0, import_jsx_runtime11.jsxs)("label", { className: "dsh-tavern-field", style: { marginTop: 8 }, children: [(0, import_jsx_runtime11.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("memory.deltaKeys") }), (0, import_jsx_runtime11.jsx)("input", { className: "dsh-tavern-input", value: deltaKeys, onChange: (e) => setDeltaKeys(e.target.value) })] }), (0, import_jsx_runtime11.jsx)("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 8 }, children: (0, import_jsx_runtime11.jsx)(Btn, { primary: true, disabled: busy || !deltaContent.trim(), onClick: () => void addDelta(), children: t2("memory.addDelta") }) })] })] }), tab === "journal" && (0, import_jsx_runtime11.jsxs)("div", { className: "dsh-tavern-list", children: [(0, import_jsx_runtime11.jsx)(Muted, { children: t2("memory.journalHint") }), journal.state.status === "ready" ? (0, import_jsx_runtime11.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 180 }, value: journalText, onChange: (e) => setJournalText(e.target.value) }) : journal.state.status === "error" ? (0, import_jsx_runtime11.jsx)(Err, { message: journal.state.message }) : (0, import_jsx_runtime11.jsx)(Skeleton, { height: 180 }), (0, import_jsx_runtime11.jsx)("div", { style: { display: "flex", justifyContent: "flex-end" }, children: (0, import_jsx_runtime11.jsx)(Btn, { primary: true, disabled: busy || journal.state.status !== "ready" || !cardId, onClick: () => void saveJournal(), children: t2("memory.saveJournal") }) })] })] })] });
}

// lib/client/panel/personas.js
var import_jsx_runtime12 = require("react/jsx-runtime");
var import_react12 = require("react");
var import_dsh_client_ui_primitives12 = require("@deepseek-ai/dsh-client-ui-primitives");
function PersonasSection(props) {
  const { remote } = props;
  const t2 = useT();
  const { state, reload } = useLoader(() => remote.listPersonas({}), []);
  const lore = useLoader(() => remote.listLorebooks({}), []);
  const [error, setError] = (0, import_react12.useState)(null);
  const [busy, setBusy] = (0, import_react12.useState)(false);
  const [editing, setEditing] = (0, import_react12.useState)(null);
  const [toDelete, setToDelete] = (0, import_react12.useState)(null);
  const [query, setQuery] = (0, import_react12.useState)("");
  const toast = useToast();
  const items = state.status === "ready" ? state.value.items : [];
  const q = query.trim().toLowerCase();
  const filtered = q === "" ? items : items.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  const save = async () => {
    if (!editing)
      return;
    if (!editing.name.trim()) {
      setError(t2("personas.nameRequired"));
      return;
    }
    await runAsync(setBusy, setError, async () => {
      const r = await remote.savePersona({ persona: editing });
      const err = errOf(r);
      if (err)
        setError(err);
      else {
        toast.show(t2("personas.saved", { name: editing.name }));
        reload();
      }
    });
  };
  const remove = async () => {
    if (!toDelete)
      return;
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deletePersona({ id: toDelete.id });
      const err = errOf(r);
      if (err)
        setError(err);
      else {
        if (editing?.id === toDelete.id)
          setEditing(null);
        setToDelete(null);
        reload();
      }
    });
  };
  const createNew = () => {
    setEditing({ id: `persona-${Date.now().toString(36)}`, name: "", description: "", avatar: null, lorebookId: null });
  };
  const setAsDefault = async (id) => {
    await runAsync(setBusy, setError, async () => {
      const current2 = await remote.getSettings({});
      if (!current2.ok) {
        setError(current2.error.message);
        return;
      }
      const defaults = { ...EMPTY_SESSION_DEFAULTS, ...current2.value.settings.defaults, personaId: id };
      const r = await remote.updateSettings({ patch: { defaults } });
      const err = errOf(r);
      if (err)
        setError(err);
      else
        toast.show(t2("personas.defaultSet"));
    });
  };
  return (0, import_jsx_runtime12.jsxs)(Section, { title: t2("section.personas"), description: t2("personas.sectionDesc"), children: [toast.node, (0, import_jsx_runtime12.jsxs)("div", { className: "dsh-tavern-toolbar", children: [(0, import_jsx_runtime12.jsx)(Btn, { size: "md", onClick: createNew, children: t2("personas.new") }), (0, import_jsx_runtime12.jsx)(Btn, { size: "md", onClick: reload, disabled: busy, children: t2("action.refresh") }), items.length >= 5 && (0, import_jsx_runtime12.jsx)(SearchInput, { label: t2("personas.searchLabel"), value: query, onChange: setQuery, placeholder: t2("personas.searchPlaceholder"), width: 220 })] }), state.status === "loading" && (0, import_jsx_runtime12.jsxs)("div", { className: "dsh-tavern-list", children: [(0, import_jsx_runtime12.jsx)(Skeleton, { height: 70, radius: 16 }), (0, import_jsx_runtime12.jsx)(Skeleton, { height: 70, radius: 16 }), (0, import_jsx_runtime12.jsx)(Skeleton, { height: 70, radius: 16 })] }), state.status === "error" && (0, import_jsx_runtime12.jsx)(Err, { message: state.message }), (0, import_jsx_runtime12.jsx)(Err, { message: error }), items.length === 0 && state.status === "ready" && (0, import_jsx_runtime12.jsxs)("div", { className: "dsh-tavern-empty", children: [(0, import_jsx_runtime12.jsx)("div", { className: "dsh-tavern-emptyIcon", children: (0, import_jsx_runtime12.jsx)(import_dsh_client_ui_primitives12.IconUserOutline16, { size: 32 }) }), (0, import_jsx_runtime12.jsx)("div", { className: "dsh-tavern-emptyTitle", children: t2("personas.emptyTitle") }), (0, import_jsx_runtime12.jsx)("div", { className: "dsh-tavern-emptyDesc", children: t2("personas.emptyDesc") })] }), q !== "" && filtered.length === 0 && state.status === "ready" && (0, import_jsx_runtime12.jsx)(SearchEmpty, { what: t2("personas.entity"), query: query.trim(), onClear: () => setQuery("") }), (0, import_jsx_runtime12.jsx)("div", { className: "dsh-tavern-list", style: { marginBottom: 12 }, children: filtered.map((p) => (0, import_jsx_runtime12.jsxs)("div", { className: "dsh-tavern-tile", ...clickableProps(() => setEditing({ ...p })), children: [(0, import_jsx_runtime12.jsxs)("div", { className: "dsh-tavern-tileMain", children: [(0, import_jsx_runtime12.jsxs)("div", { className: "dsh-tavern-tileTitleRow", children: [(0, import_jsx_runtime12.jsx)("span", { className: "dsh-tavern-tileName", children: p.name }), p.lorebookId ? (0, import_jsx_runtime12.jsx)(Badge, { children: p.lorebookId }) : null] }), (0, import_jsx_runtime12.jsx)("span", { className: "dsh-tavern-tileSub", children: p.description.trim() || t2("personas.noDescription") })] }), (0, import_jsx_runtime12.jsxs)("div", { className: "dsh-tavern-tileActions", children: [(0, import_jsx_runtime12.jsx)(IconBtn, { label: t2("action.edit"), onClick: () => setEditing({ ...p }), children: (0, import_jsx_runtime12.jsx)(import_dsh_client_ui_primitives12.IconEditOutline16, {}) }), (0, import_jsx_runtime12.jsx)(Btn, { size: "sm", disabled: busy, onClick: () => void setAsDefault(p.id), children: t2("personas.setDefault") }), (0, import_jsx_runtime12.jsx)(IconBtn, { label: t2("personas.delete"), danger: true, onClick: () => setToDelete(p), children: (0, import_jsx_runtime12.jsx)(import_dsh_client_ui_primitives12.IconTrashOutline16, {}) })] })] }, p.id)) }), (0, import_jsx_runtime12.jsx)(ConfirmDialog, { open: toDelete !== null, title: t2("personas.deleteTitle"), description: toDelete ? t2("personas.deleteDesc", { name: toDelete.name }) : "", confirmLabel: t2("action.delete"), danger: true, busy, onCancel: () => setToDelete(null), onConfirm: () => void remove() }), editing && (0, import_jsx_runtime12.jsxs)("div", { className: "dsh-tavern-card", style: { marginBottom: 12 }, children: [(0, import_jsx_runtime12.jsx)(Field, { label: t2("personas.field.name"), children: (0, import_jsx_runtime12.jsx)("input", { className: "dsh-tavern-input", style: { flex: 1 }, value: editing.name, onChange: (e) => setEditing({ ...editing, name: e.target.value }) }) }), (0, import_jsx_runtime12.jsxs)("div", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime12.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("personas.field.description") }), (0, import_jsx_runtime12.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", value: editing.description, onChange: (e) => setEditing({ ...editing, description: e.target.value }) })] }), (0, import_jsx_runtime12.jsx)(Field, { label: t2("personas.field.lorebook"), children: (0, import_jsx_runtime12.jsx)(Select, { width: "100%", value: editing.lorebookId ?? "", onChange: (v) => setEditing({ ...editing, lorebookId: v || null }), options: [
    { value: "", label: t2("personas.lorebookNone") },
    ...lore.state.status === "ready" ? lore.state.value.items.map((n) => ({ value: n, label: n })) : []
  ] }) }), (0, import_jsx_runtime12.jsxs)(SaveBar, { children: [(0, import_jsx_runtime12.jsx)(Btn, { disabled: busy, onClick: () => void save(), primary: true, children: t2("action.save") }), (0, import_jsx_runtime12.jsx)(Btn, { onClick: () => setEditing(null), children: t2("action.close") })] })] })] });
}

// lib/client/panel/presets.js
var import_jsx_runtime13 = require("react/jsx-runtime");
var import_react13 = require("react");
var import_dsh_client_ui_primitives13 = require("@deepseek-ai/dsh-client-ui-primitives");
function newEntry2(order) {
  return {
    identifier: `entry-${Date.now().toString(36)}-${order}`,
    name: t("presets.newEntryName"),
    enabled: true,
    role: "system",
    position: "relative",
    depth: 4,
    order,
    content: "",
    marker: false
  };
}
function PresetRegexList(props) {
  const t2 = useT();
  return (0, import_jsx_runtime13.jsxs)("div", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime13.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("presets.regexList.label", { count: props.scripts.length }) }), (0, import_jsx_runtime13.jsx)("div", { className: "dsh-tavern-list", children: props.scripts.map((s, i) => (0, import_jsx_runtime13.jsx)(RegexScriptRow, { script: s, index: i, onToggle: (disabled) => props.onChange(props.scripts.map((x, j) => j === i ? { ...x, disabled } : x)) }, s.id ?? i)) })] });
}
function EntryEditor(props) {
  const { entry } = props;
  const t2 = useT();
  const set = (patch) => props.onChange({ ...entry, ...patch });
  return (0, import_jsx_runtime13.jsxs)("div", { className: "dsh-tavern-entry", children: [(0, import_jsx_runtime13.jsxs)("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "12px 16px 8px" }, children: [(0, import_jsx_runtime13.jsx)(Toggle, { checked: entry.enabled, onChange: (enabled) => set({ enabled }), title: entry.enabled ? t2("presets.entry.disable") : t2("presets.entry.enable") }), (0, import_jsx_runtime13.jsx)("input", { className: "dsh-tavern-input", style: { width: 160 }, value: entry.name, placeholder: t2("presets.name"), onChange: (e) => set({ name: e.target.value }) }), (0, import_jsx_runtime13.jsx)(Select, { value: entry.role, onChange: (v) => set({ role: v }), options: [
    { value: "system", label: "system" },
    { value: "user", label: "user" },
    { value: "assistant", label: "assistant" }
  ] }), (0, import_jsx_runtime13.jsx)(Select, { value: entry.position, onChange: (v) => set({ position: v }), options: [
    { value: "relative", label: "relative" },
    { value: "in-chat", label: "in-chat" }
  ] }), entry.position === "in-chat" && (0, import_jsx_runtime13.jsxs)("label", { style: { fontSize: 12 }, children: [t2("presets.entry.depth"), " ", (0, import_jsx_runtime13.jsx)(NumInput, { value: entry.depth, width: 64, onChange: (v) => set({ depth: Math.max(0, Math.round(v)) }) })] }), (0, import_jsx_runtime13.jsxs)("label", { style: { fontSize: 12 }, children: [t2("presets.entry.order"), " ", (0, import_jsx_runtime13.jsx)(NumInput, { value: entry.order, width: 64, onChange: (v) => set({ order: Math.round(v) }) })] }), (0, import_jsx_runtime13.jsxs)("label", { style: { fontSize: 12 }, children: [(0, import_jsx_runtime13.jsx)("input", { type: "checkbox", checked: entry.marker, onChange: (e) => set({ marker: e.target.checked }) }), " ", t2("presets.entry.marker")] }), entry.marker && (0, import_jsx_runtime13.jsx)("input", { className: "dsh-tavern-input", style: { width: 140 }, value: entry.markerId ?? "", placeholder: "markerId", onChange: (e) => set({ markerId: e.target.value }) }), (0, import_jsx_runtime13.jsx)("span", { style: { flex: 1 } }), (0, import_jsx_runtime13.jsx)(IconBtn, { label: t2("presets.entry.delete"), danger: true, onClick: props.onDelete, children: (0, import_jsx_runtime13.jsx)(import_dsh_client_ui_primitives13.IconTrashOutline16, {}) })] }), !entry.marker && (0, import_jsx_runtime13.jsx)("div", { style: { padding: "2px 16px 14px" }, children: (0, import_jsx_runtime13.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 60 }, value: entry.content, placeholder: t2("presets.entry.content"), onChange: (e) => set({ content: e.target.value }) }) })] });
}
function PresetsSection(props) {
  const { remote } = props;
  const { state, reload } = useLoader(() => remote.listPresets({}), []);
  const [error, setError] = (0, import_react13.useState)(null);
  const [busy, setBusy] = (0, import_react13.useState)(false);
  const [editing, setEditing] = (0, import_react13.useState)(null);
  const [toDelete, setToDelete] = (0, import_react13.useState)(null);
  const [query, setQuery] = (0, import_react13.useState)("");
  const toast = useToast();
  const t2 = useT();
  const items = state.status === "ready" ? state.value.items : [];
  const q = query.trim().toLowerCase();
  const filtered = q === "" ? items : items.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  const open = async (id) => {
    await runAsync(setBusy, setError, async () => {
      const r = await remote.getPreset({ id });
      if (r.ok)
        setEditing(structuredClone(r.value.preset));
      else
        setError(r.error.message);
    });
  };
  const save = async () => {
    if (!editing)
      return;
    await runAsync(setBusy, setError, async () => {
      const r = await remote.savePreset({ preset: editing });
      const err = errOf(r);
      if (err)
        setError(err);
      else {
        toast.show(t2("presets.saved", { name: editing.name }));
        reload();
      }
    });
  };
  const remove = async () => {
    if (!toDelete)
      return;
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deletePreset({ id: toDelete });
      const err = errOf(r);
      if (err)
        setError(err);
      else {
        if (editing?.identifier === toDelete)
          setEditing(null);
        setToDelete(null);
        reload();
      }
    });
  };
  const onImportFile = async (file) => {
    setBusy(true);
    setError(null);
    try {
      const json = await readJsonFile(file);
      const name2 = file.name.replace(/\.json$/i, "");
      const r = await remote.importPreset({ name: name2, json });
      if (!r.ok)
        setError(r.error.message);
      else {
        toast.show(r.value.warnings.length > 0 ? t2("presets.importedWarnings", { warnings: r.value.warnings.map(String).join(t2("presets.warningSep")) }) : t2("presets.imported"));
        reload();
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2));
    } finally {
      setBusy(false);
    }
  };
  const setAsDefault = async (id) => {
    await runAsync(setBusy, setError, async () => {
      const current2 = await remote.getSettings({});
      if (!current2.ok) {
        setError(current2.error.message);
        return;
      }
      const defaults = { ...EMPTY_SESSION_DEFAULTS, ...current2.value.settings.defaults, presetId: id };
      const r = await remote.updateSettings({ patch: { defaults } });
      const err = errOf(r);
      if (err)
        setError(err);
      else
        toast.show(t2("presets.setDefaultDone"));
    });
  };
  const exportPreset = async (id, name2) => {
    await runAsync(setBusy, setError, async () => {
      const r = await remote.getPreset({ id });
      if (!r.ok) {
        setError(r.error.message);
        return;
      }
      const preset = r.value.preset;
      const prompts = preset.entries.map((e) => ({
        identifier: e.identifier,
        name: e.name,
        role: e.role,
        content: e.content,
        marker: e.marker,
        system_prompt: e.role === "system",
        injection_position: e.position === "in-chat" ? 1 : 0,
        injection_depth: e.depth,
        injection_order: e.order
      }));
      const order = preset.entries.map((e) => ({ identifier: e.identifier, enabled: e.enabled }));
      const json = {
        name: preset.name,
        identifier: preset.identifier,
        prompts,
        prompt_order: [{ character_id: 100001, order }]
      };
      if (preset.regexScripts && preset.regexScripts.length > 0) {
        json.extensions = { regex_scripts: preset.regexScripts };
      }
      downloadJson(`${name2 || id}.json`, json);
    });
  };
  const createNew = () => {
    const id = `preset-${Date.now().toString(36)}`;
    setEditing({ name: t2("presets.newPresetName"), identifier: id, entries: [newEntry2(100)] });
  };
  const setEntry = (index, entry) => {
    if (!editing)
      return;
    const entries = editing.entries.slice();
    entries[index] = entry;
    setEditing({ ...editing, entries });
  };
  return (0, import_jsx_runtime13.jsxs)(Section, { title: t2("section.presets"), description: t2("presets.section.desc"), children: [toast.node, (0, import_jsx_runtime13.jsxs)("div", { className: "dsh-tavern-toolbar", children: [(0, import_jsx_runtime13.jsx)(FileBtn, { accept: ".json", disabled: busy, onFile: (file) => void onImportFile(file), children: t2("presets.importFile") }), (0, import_jsx_runtime13.jsx)(Btn, { size: "md", onClick: createNew, children: t2("presets.new") }), (0, import_jsx_runtime13.jsx)(Btn, { size: "md", onClick: reload, disabled: busy, children: t2("action.refresh") }), items.length >= 5 && (0, import_jsx_runtime13.jsx)(SearchInput, { label: t2("presets.searchLabel"), value: query, onChange: setQuery, placeholder: t2("presets.searchPlaceholder"), width: 220 })] }), state.status === "loading" && (0, import_jsx_runtime13.jsxs)("div", { className: "dsh-tavern-list", children: [(0, import_jsx_runtime13.jsx)(Skeleton, { height: 70, radius: 16 }), (0, import_jsx_runtime13.jsx)(Skeleton, { height: 70, radius: 16 }), (0, import_jsx_runtime13.jsx)(Skeleton, { height: 70, radius: 16 })] }), state.status === "error" && (0, import_jsx_runtime13.jsx)(Err, { message: state.message }), (0, import_jsx_runtime13.jsx)(Err, { message: error }), items.length === 0 && state.status === "ready" && (0, import_jsx_runtime13.jsxs)("div", { className: "dsh-tavern-empty", children: [(0, import_jsx_runtime13.jsx)("div", { className: "dsh-tavern-emptyIcon", children: (0, import_jsx_runtime13.jsx)(import_dsh_client_ui_primitives13.IconFolderOpenOutline16, { size: 32 }) }), (0, import_jsx_runtime13.jsx)("div", { className: "dsh-tavern-emptyTitle", children: t2("presets.empty") }), (0, import_jsx_runtime13.jsx)("div", { className: "dsh-tavern-emptyDesc", children: t2("presets.emptyDesc") })] }), q !== "" && filtered.length === 0 && state.status === "ready" && (0, import_jsx_runtime13.jsx)(SearchEmpty, { what: t2("presets.noun"), query: query.trim(), onClear: () => setQuery("") }), (0, import_jsx_runtime13.jsx)("div", { className: "dsh-tavern-list", style: { marginBottom: 12 }, children: filtered.map((item) => (0, import_jsx_runtime13.jsxs)("div", { className: "dsh-tavern-tile", ...clickableProps(() => void open(item.id)), children: [(0, import_jsx_runtime13.jsx)("span", { className: "dsh-tavern-tileIcon", children: (0, import_jsx_runtime13.jsx)(import_dsh_client_ui_primitives13.IconListPenOutline16, { size: 18 }) }), (0, import_jsx_runtime13.jsxs)("div", { className: "dsh-tavern-tileMain", children: [(0, import_jsx_runtime13.jsxs)("div", { className: "dsh-tavern-tileTitleRow", children: [(0, import_jsx_runtime13.jsx)("span", { className: "dsh-tavern-tileName", children: item.name }), item.regexCount > 0 ? (0, import_jsx_runtime13.jsx)(Badge, { children: t2("presets.regexCount", { count: item.regexCount }) }) : null] }), (0, import_jsx_runtime13.jsx)("span", { className: "dsh-tavern-tileSub", children: item.id })] }), (0, import_jsx_runtime13.jsxs)("div", { className: "dsh-tavern-tileActions", children: [(0, import_jsx_runtime13.jsx)(IconBtn, { label: t2("action.edit"), onClick: () => void open(item.id), children: (0, import_jsx_runtime13.jsx)(import_dsh_client_ui_primitives13.IconEditOutline16, {}) }), (0, import_jsx_runtime13.jsx)(IconBtn, { label: t2("presets.export"), disabled: busy, onClick: () => void exportPreset(item.id, item.name), children: (0, import_jsx_runtime13.jsx)(import_dsh_client_ui_primitives13.IconDownloadOutline16, {}) }), (0, import_jsx_runtime13.jsx)(Btn, { size: "sm", disabled: busy, onClick: () => void setAsDefault(item.id), children: t2("presets.setAsDefault") }), (0, import_jsx_runtime13.jsx)(IconBtn, { label: t2("presets.delete"), danger: true, onClick: () => setToDelete(item.id), children: (0, import_jsx_runtime13.jsx)(import_dsh_client_ui_primitives13.IconTrashOutline16, {}) })] })] }, item.id)) }), (0, import_jsx_runtime13.jsx)(ConfirmDialog, { open: toDelete !== null, title: t2("presets.deleteTitle"), description: toDelete ? t2("presets.deleteDesc", { id: toDelete }) : "", confirmLabel: t2("action.delete"), danger: true, busy, onCancel: () => setToDelete(null), onConfirm: () => void remove() }), editing && (0, import_jsx_runtime13.jsxs)("div", { className: "dsh-tavern-card", style: { marginBottom: 12 }, children: [(0, import_jsx_runtime13.jsx)(Field, { label: t2("presets.name"), children: (0, import_jsx_runtime13.jsx)("input", { className: "dsh-tavern-input", style: { flex: 1 }, value: editing.name, onChange: (e) => setEditing({ ...editing, name: e.target.value }) }) }), (0, import_jsx_runtime13.jsx)(Field, { label: t2("presets.identifier"), children: (0, import_jsx_runtime13.jsx)(Muted, { children: editing.identifier }) }), (editing.regexScripts?.length ?? 0) > 0 && (0, import_jsx_runtime13.jsx)(PresetRegexList, { scripts: editing.regexScripts, onChange: (scripts) => setEditing({ ...editing, regexScripts: scripts }) }), (0, import_jsx_runtime13.jsx)("div", { className: "dsh-tavern-list", style: { margin: "8px 0" }, children: editing.entries.map((entry, i) => (0, import_jsx_runtime13.jsx)(EntryEditor, { entry, onChange: (e2) => setEntry(i, e2), onDelete: () => setEditing({ ...editing, entries: editing.entries.filter((_, j) => j !== i) }) }, entry.identifier)) }), (0, import_jsx_runtime13.jsxs)(SaveBar, { children: [(0, import_jsx_runtime13.jsx)(Btn, { onClick: () => setEditing({ ...editing, entries: [...editing.entries, newEntry2(editing.entries.length * 100 + 100)] }), children: t2("presets.addEntry") }), (0, import_jsx_runtime13.jsx)(Btn, { disabled: busy, onClick: () => void save(), primary: true, children: t2("presets.save") }), (0, import_jsx_runtime13.jsx)(Btn, { onClick: () => setEditing(null), children: t2("action.close") })] })] })] });
}

// lib/client/panel/regex.js
var import_jsx_runtime14 = require("react/jsx-runtime");
var import_react14 = require("react");
var import_dsh_client_ui_primitives14 = require("@deepseek-ai/dsh-client-ui-primitives");
var SCOPES = [
  { value: "input", labelKey: "regex.scope.input" },
  { value: "output", labelKey: "regex.scope.output" },
  { value: "prompt", labelKey: "regex.scope.prompt" }
];
var TIMINGS = [
  { value: "assemble", labelKey: "regex.timing.assemble" },
  { value: "send", labelKey: "regex.timing.send" },
  { value: "render", labelKey: "regex.timing.render" }
];
var SOURCE_LABEL_KEY = { user: "regex.source.user", card: "regex.source.card", preset: "regex.source.preset" };
function newRule() {
  return {
    id: `rule-${Date.now().toString(36)}`,
    name: t("regex.newRuleName"),
    find: "",
    replace: "",
    enabled: true,
    scopes: ["output"],
    timing: ["render"],
    minDepth: null,
    maxDepth: null,
    substituteRegex: 0,
    source: "user"
  };
}
function RuleEditor(props) {
  const t2 = useT();
  const { rule } = props;
  const set = (patch) => props.onChange({ ...rule, ...patch });
  return (0, import_jsx_runtime14.jsxs)("div", { className: "dsh-tavern-entry", style: { marginBottom: 8 }, children: [(0, import_jsx_runtime14.jsxs)("div", { style: { display: "flex", gap: 10, alignItems: "center", padding: "12px 16px 8px" }, children: [(0, import_jsx_runtime14.jsx)(Toggle, { checked: rule.enabled, onChange: (enabled) => set({ enabled }), title: rule.enabled ? t2("regex.toggleDisable") : t2("regex.toggleEnable") }), (0, import_jsx_runtime14.jsx)("input", { className: "dsh-tavern-input", style: { flex: 1 }, value: rule.name, onChange: (e) => set({ name: e.target.value }) }), (0, import_jsx_runtime14.jsx)(Badge, { children: t2(SOURCE_LABEL_KEY[rule.source]) }), (0, import_jsx_runtime14.jsx)(IconBtn, { label: t2("regex.deleteRule"), danger: true, onClick: props.onDelete, children: (0, import_jsx_runtime14.jsx)(import_dsh_client_ui_primitives14.IconTrashOutline16, {}) })] }), (0, import_jsx_runtime14.jsxs)("div", { style: { padding: "2px 16px 14px" }, children: [(0, import_jsx_runtime14.jsx)(Field, { label: t2("regex.find"), children: (0, import_jsx_runtime14.jsx)("input", { className: "dsh-tavern-input dsh-tavern-codeFont", style: { flex: 1 }, value: rule.find, onChange: (e) => set({ find: e.target.value }) }) }), (0, import_jsx_runtime14.jsx)("div", { className: "dsh-tavern-fieldLabel", style: { margin: "4px 0" }, children: t2("regex.replace") }), (0, import_jsx_runtime14.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont", style: { minHeight: 40 }, value: rule.replace, onChange: (e) => set({ replace: e.target.value }) }), (0, import_jsx_runtime14.jsxs)("div", { className: "dsh-tavern-fieldRow", style: { margin: "8px 0 4px" }, children: [(0, import_jsx_runtime14.jsxs)("div", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime14.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("regex.scope") }), (0, import_jsx_runtime14.jsx)(CheckChips, { ariaLabel: t2("regex.scope"), options: SCOPES.map((o) => ({ value: o.value, label: t2(o.labelKey) })), selected: rule.scopes, onChange: (scopes) => set({ scopes }) })] }), (0, import_jsx_runtime14.jsxs)("div", { className: "dsh-tavern-field", children: [(0, import_jsx_runtime14.jsx)("span", { className: "dsh-tavern-fieldLabel", children: t2("regex.timing") }), (0, import_jsx_runtime14.jsx)(CheckChips, { ariaLabel: t2("regex.timing"), options: TIMINGS.map((o) => ({ value: o.value, label: t2(o.labelKey) })), selected: rule.timing, onChange: (timing) => set({ timing }) })] })] }), (0, import_jsx_runtime14.jsxs)("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, alignItems: "center" }, children: [(0, import_jsx_runtime14.jsxs)("label", { children: [t2("regex.minDepth"), " ", (0, import_jsx_runtime14.jsx)(NullableNumInput, { value: rule.minDepth, width: 64, onChange: (v) => set({ minDepth: v }) })] }), (0, import_jsx_runtime14.jsxs)("label", { children: [t2("regex.maxDepth"), " ", (0, import_jsx_runtime14.jsx)(NullableNumInput, { value: rule.maxDepth, width: 64, onChange: (v) => set({ maxDepth: v }) })] }), (0, import_jsx_runtime14.jsxs)("label", { children: [t2("regex.macroExpand"), " ", (0, import_jsx_runtime14.jsx)(Select, { value: String(rule.substituteRegex), onChange: (v) => set({ substituteRegex: Number(v) }), options: [
    { value: "0", label: t2("regex.substitute.none") },
    { value: "1", label: t2("regex.substitute.raw") },
    { value: "2", label: t2("regex.substitute.escaped") }
  ] })] })] })] })] });
}
function RegexSection(props) {
  const t2 = useT();
  const { remote } = props;
  const { state, reload } = useLoader(() => remote.listRegexRules({}), []);
  const [rules, setRules] = (0, import_react14.useState)(null);
  const [error, setError] = (0, import_react14.useState)(null);
  const [busy, setBusy] = (0, import_react14.useState)(false);
  const toast = useToast();
  (0, import_react14.useEffect)(() => {
    if (state.status === "ready" && rules === null)
      setRules(structuredClone(state.value.rules));
  }, [state]);
  const presetRegex = useLoader(async () => {
    const list = await remote.listPresets({});
    if (!list.ok)
      return list;
    const items = [];
    for (const p of list.value.items) {
      if (p.regexCount <= 0)
        continue;
      const r = await remote.getPreset({ id: p.id });
      if (r.ok && (r.value.preset.regexScripts?.length ?? 0) > 0)
        items.push(r.value.preset);
    }
    return { ok: true, value: { items } };
  }, []);
  const [presetDrafts, setPresetDrafts] = (0, import_react14.useState)(null);
  (0, import_react14.useEffect)(() => {
    if (presetRegex.state.status === "ready" && presetDrafts === null)
      setPresetDrafts(structuredClone(presetRegex.state.value.items));
  }, [presetRegex.state]);
  const togglePresetScript = async (pi, si, disabled) => {
    const drafts = presetDrafts ?? [];
    const preset = drafts[pi];
    const script = preset?.regexScripts?.[si];
    if (!preset || !script)
      return;
    const nextPreset = {
      ...preset,
      regexScripts: preset.regexScripts.map((s, i) => i === si ? { ...s, disabled } : s)
    };
    setPresetDrafts(drafts.map((p, i) => i === pi ? nextPreset : p));
    await runAsync(setBusy, setError, async () => {
      const r = await remote.savePreset({ preset: nextPreset }).catch((e) => {
        setPresetDrafts(drafts);
        throw e;
      });
      const err = errOf(r);
      if (err) {
        setError(err);
        setPresetDrafts(drafts);
      } else {
        const name2 = script.scriptName?.trim() || t2("util.regex.unnamed", { index: si + 1 });
        toast.show(disabled ? t2("regex.toggledOff", { name: name2 }) : t2("regex.toggledOn", { name: name2 }));
      }
    });
  };
  const save = (next) => runAsync(setBusy, setError, async () => {
    const r = await remote.saveRegexRules({ rules: next });
    const err = errOf(r);
    if (err)
      setError(err);
    else
      toast.show(t2("regex.saved", { count: next.length }));
  });
  const current2 = rules ?? [];
  return (0, import_jsx_runtime14.jsxs)(Section, { description: t2("regex.liveNotice"), title: t2("section.regex"), children: [toast.node, (0, import_jsx_runtime14.jsx)(Muted, { children: t2("regex.desc") }), state.status === "loading" && (0, import_jsx_runtime14.jsxs)(import_jsx_runtime14.Fragment, { children: [(0, import_jsx_runtime14.jsx)(Skeleton, { height: 72 }), (0, import_jsx_runtime14.jsx)(Skeleton, { height: 72 }), (0, import_jsx_runtime14.jsx)(Skeleton, { height: 72 })] }), state.status === "error" && (0, import_jsx_runtime14.jsx)(Err, { message: state.message }), (0, import_jsx_runtime14.jsx)(Err, { message: error }), rules !== null && (0, import_jsx_runtime14.jsxs)(import_jsx_runtime14.Fragment, { children: [current2.map((rule, i) => (0, import_jsx_runtime14.jsx)(RuleEditor, { rule, onChange: (r) => {
    const next = current2.slice();
    next[i] = r;
    setRules(next);
  }, onDelete: () => setRules(current2.filter((_, j) => j !== i)) }, rule.id)), current2.length === 0 && (0, import_jsx_runtime14.jsxs)("div", { className: "dsh-tavern-empty is-compact", children: [(0, import_jsx_runtime14.jsx)("div", { className: "dsh-tavern-emptyTitle", children: t2("regex.emptyTitle") }), (0, import_jsx_runtime14.jsx)("div", { className: "dsh-tavern-emptyDesc", children: t2("regex.emptyDesc") })] }), (0, import_jsx_runtime14.jsxs)(SaveBar, { children: [(0, import_jsx_runtime14.jsx)(Btn, { onClick: () => setRules([...current2, newRule()]), children: t2("regex.new") }), (0, import_jsx_runtime14.jsx)(Btn, { disabled: busy, onClick: () => void save(current2), primary: true, children: t2("regex.saveAll") }), (0, import_jsx_runtime14.jsx)(Btn, { onClick: () => {
    setRules(null);
    reload();
  }, children: t2("regex.discard") })] })] }), (0, import_jsx_runtime14.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("regex.presetHead") }), presetRegex.state.status === "loading" && (0, import_jsx_runtime14.jsxs)(import_jsx_runtime14.Fragment, { children: [(0, import_jsx_runtime14.jsx)(Skeleton, { height: 56 }), (0, import_jsx_runtime14.jsx)(Skeleton, { height: 56 })] }), presetRegex.state.status === "error" && (0, import_jsx_runtime14.jsx)(Err, { message: presetRegex.state.message }), presetDrafts !== null && presetDrafts.length === 0 && (0, import_jsx_runtime14.jsx)(Muted, { children: t2("regex.noPresetRegex") }), (presetDrafts ?? []).map((preset, pi) => (0, import_jsx_runtime14.jsxs)("div", { children: [(0, import_jsx_runtime14.jsx)("div", { className: "dsh-tavern-fieldLabel", style: { margin: "12px 0 6px" }, children: t2("regex.presetCount", { name: preset.name?.trim() || preset.identifier, count: preset.regexScripts.length }) }), (0, import_jsx_runtime14.jsx)("div", { className: "dsh-tavern-list", children: preset.regexScripts.map((s, si) => (0, import_jsx_runtime14.jsx)(RegexScriptRow, { script: s, index: si, disabled: busy, onToggle: (disabled) => void togglePresetScript(pi, si, disabled) }, s.id ?? si)) })] }, preset.identifier))] });
}

// lib/client/panel/settings.js
var import_jsx_runtime15 = require("react/jsx-runtime");
var import_react15 = require("react");
var SUBS = [
  { id: "interface", labelKey: "settings.sub.interface" },
  { id: "defaults", labelKey: "settings.sub.defaults" },
  { id: "sampling", labelKey: "settings.sub.sampling" },
  { id: "worldinfo", labelKey: "settings.sub.worldinfo" },
  { id: "memory", labelKey: "settings.sub.memory" },
  { id: "cards", labelKey: "settings.sub.cards" }
];
var lastSub;
function SettingsSection(props) {
  const { remote } = props;
  const t2 = useT();
  const { state, reload } = useLoader(() => remote.getSettings({}), []);
  const dataInfo = useLoader(() => remote.getDataInfo({}), []);
  const presets = useLoader(() => remote.listPresets({}), []);
  const lore = useLoader(() => remote.listLorebooks({}), []);
  const personas = useLoader(() => remote.listPersonas({}), []);
  const [sub, setSub] = (0, import_react15.useState)(lastSub ?? "interface");
  const [draft, setDraft] = (0, import_react15.useState)(null);
  const [error, setError] = (0, import_react15.useState)(null);
  const [busy, setBusy] = (0, import_react15.useState)(false);
  const toast = useToast();
  const toDraft = (settings) => ({
    ...structuredClone(settings),
    defaults: { ...EMPTY_SESSION_DEFAULTS, ...settings.defaults },
    worldInfo: { ...settings.worldInfo, useGroupScoring: settings.worldInfo.useGroupScoring ?? false }
  });
  (0, import_react15.useEffect)(() => {
    if (state.status === "ready")
      setDraft(toDraft(state.value.settings));
  }, [state]);
  const save = (patch, toastText) => runAsync(setBusy, setError, async () => {
    const r = await remote.updateSettings({ patch });
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    const saved = toDraft(r.value.settings);
    setDraft((current2) => {
      if (!current2)
        return saved;
      const next = { ...current2 };
      for (const key of Object.keys(patch)) {
        ;
        next[key] = structuredClone(saved[key]);
      }
      return next;
    });
    toast.show(toastText);
  });
  const changeLocale = (locale) => {
    if (!draft || locale === draft.locale)
      return;
    const prev = draft.locale;
    setDraft({ ...draft, locale });
    setTavernLocale(locale);
    void runAsync(setBusy, setError, async () => {
      const r = await remote.updateSettings({ patch: { locale } });
      if (!r.ok) {
        setDraft((current2) => current2 ? { ...current2, locale: prev } : current2);
        setTavernLocale(prev);
        setError(`${t2("settings.interface.languageFailed")}: ${r.error.message}`);
      }
    });
  };
  if (state.status === "loading")
    return (0, import_jsx_runtime15.jsxs)(Section, { title: t2("settings.title"), children: [(0, import_jsx_runtime15.jsx)(Skeleton, { height: 56 }), (0, import_jsx_runtime15.jsx)(Skeleton, { height: 56 }), (0, import_jsx_runtime15.jsx)(Skeleton, { height: 56 })] });
  if (state.status === "error")
    return (0, import_jsx_runtime15.jsxs)(Section, { title: t2("settings.title"), children: [(0, import_jsx_runtime15.jsx)(Err, { message: state.message }), (0, import_jsx_runtime15.jsx)(Btn, { size: "md", onClick: reload, children: t2("action.retry") })] });
  if (!draft)
    return null;
  const presetItems = presets.state.status === "ready" ? presets.state.value.items : [];
  const lorebooks = lore.state.status === "ready" ? lore.state.value.items : [];
  const personaItems = personas.state.status === "ready" ? personas.state.value.items : [];
  const setSampling = (patch) => setDraft({ ...draft, sampling: { ...draft.sampling, ...patch } });
  const setWorldInfo = (patch) => setDraft({ ...draft, worldInfo: { ...draft.worldInfo, ...patch } });
  const setMemory = (patch) => setDraft({ ...draft, memory: { ...draft.memory, ...patch } });
  const setDefaults = (patch) => setDraft({ ...draft, defaults: { ...draft.defaults, ...patch } });
  return (0, import_jsx_runtime15.jsxs)(import_jsx_runtime15.Fragment, { children: [toast.node, (0, import_jsx_runtime15.jsx)(Tabs, { items: SUBS.map((s) => ({ id: s.id, label: t2(s.labelKey) })), value: sub, onChange: (id) => {
    lastSub = id;
    setSub(id);
  } }), (0, import_jsx_runtime15.jsxs)("div", { className: "dsh-tavern-rise", children: [sub === "interface" && (0, import_jsx_runtime15.jsx)(Section, { title: t2("settings.interface.title"), description: t2("settings.interface.desc"), children: (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.interface.language"), description: t2("settings.interface.languageDesc"), children: (0, import_jsx_runtime15.jsx)(Select, { size: "md", value: draft.locale, onChange: (v) => changeLocale(v === "zh" ? "zh" : v === "en" ? "en" : "auto"), options: [
    { value: "auto", label: t2("settings.interface.localeAuto") },
    { value: "en", label: "English" },
    { value: "zh", label: "\u4E2D\u6587" }
  ] }) }) }), sub === "defaults" && (0, import_jsx_runtime15.jsxs)(Section, { title: t2("settings.defaults.title"), description: t2("settings.defaults.desc"), children: [(0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.defaults.preset"), description: t2("settings.defaults.presetDesc"), children: (0, import_jsx_runtime15.jsx)(Select, { size: "md", value: draft.defaults.presetId, onChange: (presetId) => setDefaults({ presetId }), options: [
    { value: "", label: t2("settings.defaults.builtinPreset") },
    ...presetItems.map((p) => ({
      value: p.id,
      label: p.regexCount > 0 ? t2("settings.defaults.presetRegexCount", { name: p.name, count: p.regexCount }) : p.name
    }))
  ] }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.defaults.persona"), description: t2("settings.defaults.personaDesc"), children: (0, import_jsx_runtime15.jsx)(Select, { size: "md", value: draft.defaults.personaId, onChange: (personaId) => setDefaults({ personaId }), options: [{ value: "", label: t2("settings.defaults.noPersona") }, ...personaItems.map((p) => ({ value: p.id, label: p.name }))] }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.defaults.mainLore"), description: t2("settings.defaults.mainLoreDesc"), children: (0, import_jsx_runtime15.jsx)(Select, { size: "md", value: draft.defaults.characterLorebookId, onChange: (characterLorebookId) => setDefaults({ characterLorebookId }), options: [{ value: "", label: t2("settings.defaults.embeddedLore") }, ...lorebooks.map((n) => ({ value: n, label: n }))] }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.defaults.globalLore"), description: t2("settings.defaults.globalLoreDesc"), stacked: true, children: lorebooks.length === 0 ? (0, import_jsx_runtime15.jsx)(Muted, { children: t2("settings.defaults.noLorebooks") }) : (0, import_jsx_runtime15.jsx)(CheckChips, { ariaLabel: t2("settings.defaults.globalLore"), options: lorebooks.map((n) => ({ value: n, label: n })), selected: draft.defaults.lorebookIds, onChange: (lorebookIds) => setDefaults({ lorebookIds }) }) }), (0, import_jsx_runtime15.jsx)(SaveBar, { children: (0, import_jsx_runtime15.jsx)(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void save({ defaults: draft.defaults }, t2("settings.defaults.saved")), children: t2("settings.defaults.save") }) })] }), sub === "sampling" && (0, import_jsx_runtime15.jsxs)(Section, { title: t2("settings.sampling.title"), description: t2("settings.sampling.desc"), children: [(0, import_jsx_runtime15.jsx)(SettingsRow, { title: "temperature", description: t2("settings.sampling.temperatureDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { step: "0.05", value: draft.sampling.temperature, onChange: (v) => setSampling({ temperature: v }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: "topP", description: t2("settings.sampling.topPDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { step: "0.05", value: draft.sampling.topP, onChange: (v) => setSampling({ topP: v }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: "maxTokens", description: t2("settings.sampling.maxTokensDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.sampling.maxTokens, onChange: (v) => setSampling({ maxTokens: Math.max(0, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: "presencePenalty", children: (0, import_jsx_runtime15.jsx)(NumInput, { step: "0.1", value: draft.sampling.presencePenalty, onChange: (v) => setSampling({ presencePenalty: v }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: "frequencyPenalty", children: (0, import_jsx_runtime15.jsx)(NumInput, { step: "0.1", value: draft.sampling.frequencyPenalty, onChange: (v) => setSampling({ frequencyPenalty: v }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.sampling.thinking"), description: t2("settings.sampling.thinkingDesc"), children: (0, import_jsx_runtime15.jsx)(Select, { size: "md", value: draft.sampling.thinking, onChange: (v) => setSampling({ thinking: v }), options: [
    { value: "disabled", label: t2("settings.sampling.thinking.disabled") },
    { value: "enabled", label: t2("settings.sampling.thinking.enabled") },
    { value: "low", label: t2("settings.sampling.thinking.low") },
    { value: "high", label: t2("settings.sampling.thinking.high") },
    { value: "max", label: t2("settings.sampling.thinking.max") }
  ] }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.sampling.stop"), description: t2("settings.sampling.stopDesc"), stacked: true, children: (0, import_jsx_runtime15.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont", style: { minHeight: 64 }, value: draft.sampling.stop.join("\n"), onChange: (e) => setSampling({ stop: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) }) }) }), (0, import_jsx_runtime15.jsx)(SaveBar, { children: (0, import_jsx_runtime15.jsx)(Btn, { disabled: busy, onClick: () => void save({ sampling: draft.sampling }, t2("settings.sampling.saved")), primary: true, size: "md", children: t2("settings.sampling.save") }) })] }), sub === "worldinfo" && (0, import_jsx_runtime15.jsxs)(Section, { title: t2("settings.worldinfo.title"), description: t2("settings.worldinfo.desc"), children: [(0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.worldinfo.scanDepth"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.worldInfo.scanDepth, onChange: (v) => setWorldInfo({ scanDepth: Math.max(0, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.worldinfo.contextPercent"), description: t2("settings.worldinfo.contextPercentDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.worldInfo.contextPercent, onChange: (v) => setWorldInfo({ contextPercent: v }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.worldinfo.tokenBudget"), description: t2("settings.worldinfo.tokenBudgetDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.worldInfo.tokenBudget, onChange: (v) => setWorldInfo({ tokenBudget: Math.max(0, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.worldinfo.maxRecursionSteps"), description: t2("settings.worldinfo.maxRecursionStepsDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.worldInfo.maxRecursionSteps, onChange: (v) => setWorldInfo({ maxRecursionSteps: Math.max(0, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.worldinfo.strategy"), children: (0, import_jsx_runtime15.jsx)(Select, { size: "md", value: String(draft.worldInfo.characterStrategy), onChange: (v) => setWorldInfo({ characterStrategy: Number(v) }), options: [
    { value: "0", label: "Sorted Evenly" },
    { value: "1", label: "Character Lore First" },
    { value: "2", label: "Global Lore First" }
  ] }) }), [
    ["recursiveScan", "settings.worldinfo.recursiveScan", "settings.worldinfo.recursiveScanDesc"],
    ["caseSensitive", "settings.worldinfo.caseSensitive", ""],
    ["matchWholeWords", "settings.worldinfo.matchWholeWords", "settings.worldinfo.matchWholeWordsDesc"],
    ["includeNames", "settings.worldinfo.includeNames", ""],
    ["overflowWarning", "settings.worldinfo.overflowWarning", ""],
    ["useGroupScoring", "settings.worldinfo.useGroupScoring", "settings.worldinfo.useGroupScoringDesc"]
  ].map(([key, titleKey, descKey]) => (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2(titleKey), description: descKey ? t2(descKey) : void 0, children: (0, import_jsx_runtime15.jsx)(Toggle, { checked: draft.worldInfo[key], onChange: (on) => setWorldInfo({ [key]: on }) }) }, key)), (0, import_jsx_runtime15.jsx)(SaveBar, { children: (0, import_jsx_runtime15.jsx)(Btn, { disabled: busy, onClick: () => void save({ worldInfo: draft.worldInfo }, t2("settings.worldinfo.saved")), primary: true, size: "md", children: t2("settings.worldinfo.save") }) })] }), sub === "memory" && (0, import_jsx_runtime15.jsxs)(Section, { title: t2("settings.memory.title"), description: t2("settings.memory.desc"), children: [(0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.memory.maxEntries"), description: t2("settings.memory.maxEntriesDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.memory.maxEntries, onChange: (v) => setMemory({ maxEntries: Math.max(1, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.memory.maxTokens"), description: t2("settings.memory.maxTokensDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.memory.maxTokens, onChange: (v) => setMemory({ maxTokens: Math.max(0, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.memory.retrievalTopK"), description: t2("settings.memory.retrievalTopKDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.memory.retrievalTopK, onChange: (v) => setMemory({ retrievalTopK: Math.max(0, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.memory.retrievalTokenBudget"), description: t2("settings.memory.retrievalTokenBudgetDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.memory.retrievalTokenBudget, onChange: (v) => setMemory({ retrievalTokenBudget: Math.max(0, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.memory.halfLifeDays"), description: t2("settings.memory.halfLifeDaysDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.memory.halfLifeDays, onChange: (v) => setMemory({ halfLifeDays: Math.max(0, v) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.memory.dedupScore"), description: t2("settings.memory.dedupScoreDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.memory.dedupScore, onChange: (v) => setMemory({ dedupScore: Math.max(0, v) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.memory.compressBatch"), description: t2("settings.memory.compressBatchDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.memory.compressBatch, onChange: (v) => setMemory({ compressBatch: Math.max(2, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.memory.queryMessages"), description: t2("settings.memory.queryMessagesDesc"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.memory.queryMessages, onChange: (v) => setMemory({ queryMessages: Math.max(1, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SaveBar, { children: (0, import_jsx_runtime15.jsx)(Btn, { disabled: busy, onClick: () => void save({ memory: draft.memory }, t2("settings.memory.saved")), primary: true, size: "md", children: t2("settings.memory.save") }) })] }), sub === "cards" && (0, import_jsx_runtime15.jsxs)(import_jsx_runtime15.Fragment, { children: [(0, import_jsx_runtime15.jsxs)(Section, { title: t2("settings.cards.title"), description: t2("settings.cards.desc"), children: [(0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.cards.cascadeDelete"), description: t2("settings.cards.cascadeDeleteDesc"), children: (0, import_jsx_runtime15.jsx)(Toggle, { checked: draft.cascadeDeleteEmbeddedBook, onChange: (cascadeDeleteEmbeddedBook) => setDraft({ ...draft, cascadeDeleteEmbeddedBook }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.cards.interactiveCards"), description: t2("settings.cards.interactiveCardsDesc"), children: (0, import_jsx_runtime15.jsx)(Toggle, { checked: draft.interactiveCards, onChange: (interactiveCards) => setDraft({ ...draft, interactiveCards }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.cards.triggerLogMax"), children: (0, import_jsx_runtime15.jsx)(NumInput, { value: draft.triggerLogMax, onChange: (v) => setDraft({ ...draft, triggerLogMax: Math.max(10, Math.round(v)) }) }) }), (0, import_jsx_runtime15.jsx)(SettingsRow, { title: t2("settings.cards.whitelist"), description: t2("settings.cards.whitelistDesc"), stacked: true, children: (0, import_jsx_runtime15.jsx)("textarea", { className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont", style: { minHeight: 64 }, value: draft.cardNetworkWhitelist.join("\n"), onChange: (e) => setDraft({ ...draft, cardNetworkWhitelist: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) }) }) }), (0, import_jsx_runtime15.jsx)(SaveBar, { children: (0, import_jsx_runtime15.jsx)(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void save({
    cascadeDeleteEmbeddedBook: draft.cascadeDeleteEmbeddedBook,
    interactiveCards: draft.interactiveCards,
    triggerLogMax: draft.triggerLogMax,
    cardNetworkWhitelist: draft.cardNetworkWhitelist
  }, t2("settings.cards.saved")), children: t2("settings.cards.save") }) })] }), (0, import_jsx_runtime15.jsx)("div", { className: "dsh-tavern-groupHead", children: t2("settings.cards.dataHome") }), (0, import_jsx_runtime15.jsx)(Muted, { children: (0, import_jsx_runtime15.jsxs)("span", { style: { wordBreak: "break-all" }, children: [t2("settings.cards.dataHomeDesc"), dataInfo.state.status === "ready" ? dataInfo.state.value.dataHome : "\u2026"] }) })] })] }, sub), (0, import_jsx_runtime15.jsx)(Err, { message: error })] });
}

// lib/client/panel/index.js
var TABS = [
  { id: "characters", labelKey: "panel.tab.characters" },
  { id: "presets", labelKey: "panel.tab.presets" },
  { id: "lorebooks", labelKey: "panel.tab.lorebooks" },
  { id: "personas", labelKey: "panel.tab.personas" },
  { id: "regex", labelKey: "panel.tab.regex" },
  { id: "memory", labelKey: "panel.tab.memory" },
  { id: "sampling", labelKey: "panel.tab.settings" }
];
var lastTab;
function TavernPanel(props) {
  const { remote } = props;
  const t2 = useT();
  const [tab, setTab] = (0, import_react16.useState)(lastTab ?? "characters");
  return (0, import_jsx_runtime16.jsxs)("div", { className: "dsh-tavern-ui dsh-tavern-panel", style: { width: "100%", maxWidth: "100%", fontSize: 14, boxSizing: "border-box" }, children: [(0, import_jsx_runtime16.jsx)(Tabs, { items: TABS.map((tab_) => ({ id: tab_.id, label: t2(tab_.labelKey) })), value: tab, onChange: (id) => {
    lastTab = id;
    setTab(id);
  } }), (0, import_jsx_runtime16.jsxs)("div", { className: "dsh-tavern-rise", children: [tab === "characters" && (0, import_jsx_runtime16.jsx)(CharactersSection, { remote }), tab === "presets" && (0, import_jsx_runtime16.jsx)(PresetsSection, { remote }), tab === "lorebooks" && (0, import_jsx_runtime16.jsx)(LorebooksSection, { remote }), tab === "personas" && (0, import_jsx_runtime16.jsx)(PersonasSection, { remote }), tab === "regex" && (0, import_jsx_runtime16.jsx)(RegexSection, { remote }), tab === "memory" && (0, import_jsx_runtime16.jsx)(MemorySection, { remote }), tab === "sampling" && (0, import_jsx_runtime16.jsx)(SettingsSection, { remote })] }, tab)] });
}

// lib/client/seatWatch.js
var TAVERN_SEAT_LABEL = "Tavern \u6A21\u5F0F";
var SEAT_HINTS = ["\u5373\u5C06\u5F00\u59CB\u7684\u8FD9\u4E2A\u4F1A\u8BDD\u6240\u7528\u7684 Agent \u9884\u8BBE", "Agent preset for the session you are about to start"];
function seatShowsTavern() {
  const chips = document.querySelectorAll('button[aria-haspopup="menu"]');
  for (let i = 0; i < chips.length; i++) {
    const chip = chips[i];
    if (chip && SEAT_HINTS.includes(chip.getAttribute("title") ?? "")) {
      return (chip.textContent ?? "").includes(TAVERN_SEAT_LABEL);
    }
  }
  return null;
}
function installTavernSeatWatch(ctx) {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {
    };
  }
  let baselineDone = false;
  let lastTavern = false;
  let coolingDown = false;
  let timer;
  let observer;
  const check = () => {
    timer = void 0;
    const tavern = seatShowsTavern();
    if (tavern === null)
      return;
    if (!baselineDone) {
      baselineDone = true;
      lastTavern = tavern;
      return;
    }
    if (tavern === lastTavern)
      return;
    lastTavern = tavern;
    if (!tavern || coolingDown)
      return;
    if (ctx.sessions.list.getSnapshot().current !== void 0)
      return;
    coolingDown = true;
    setTimeout(() => {
      coolingDown = false;
    }, 1500);
    try {
      const uiWorkspace = ctx.get("uiWorkspace");
      if (uiWorkspace && typeof uiWorkspace.startSession === "function")
        uiWorkspace.startSession();
      else
        ctx.workspaces.startSession?.();
    } catch {
    }
  };
  const schedule = () => {
    if (timer !== void 0)
      return;
    timer = setTimeout(check, 200);
  };
  const start = () => {
    if (observer || !document.body)
      return;
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    schedule();
  };
  if (document.body)
    start();
  else
    document.addEventListener("DOMContentLoaded", start, { once: true });
  return () => {
    document.removeEventListener("DOMContentLoaded", start);
    observer?.disconnect();
    if (timer !== void 0)
      clearTimeout(timer);
  };
}

// lib/client/index.js
var name = "dsh-tavern-client";
var inject = ["slots", "remote", "locale", "sessions", "workspaces"];
async function apply(ctx) {
  await ctx.remote.$mount(TYPERT_REMOTE);
  const remote = ctx.get("remote.tavern");
  const sessions = ctx.sessions;
  try {
    const result = await remote.getSettings({});
    if (result.ok)
      setTavernLocale(result.value.settings.locale);
  } catch {
  }
  ctx.effect(() => {
    const sync = () => setTavernHostLocale(ctx.locale.getSnapshot?.().active ?? "en");
    sync();
    return ctx.locale.subscribe?.(sync) ?? (() => {
    });
  }, "dsh-tavern: host locale");
  ctx.effect(() => ctx.locale.register("tavern", { zh: zh17, en: en17 }), "dsh-tavern: locale");
  ctx.effect(() => installTavernSeatWatch(ctx), "dsh-tavern: seat watch");
  const mount = (slotName, options, component) => {
    if (typeof ctx.slots.inject === "function") {
      ctx.slots.inject(slotName, () => ctx.slots.register({ ...options, name: slotName }, component));
    } else {
      ctx.effect(() => ctx.slots.register({ ...options, name: slotName }, component), `dsh-tavern: slot ${slotName}`);
    }
  };
  mount("settings.section", { id: "tavern", order: 50, label: "Tavern", inject: () => ({ remote }) }, TavernPanel);
  mount("conversation.chat.assistant-actions", { id: "tavern-floors", order: 20, inject: (sessionId) => ({ remote, sessionId, sessions }) }, TavernFloorActions);
  mount("conversation.session.header.actions", { id: "tavern-binding", order: 20, inject: (sessionId) => ({ remote, sessionId, sessions }) }, TavernHeaderChip);
  mount("conversation.input.dock", { id: "tavern-hero-character", order: -20, inject: (sessionId) => ({ remote, sessionId, sessions }) }, TavernHeroCharacter);
  ctx.effect(() => {
    let nodeDispose;
    const applyNode = (want) => {
      if (want) {
        if (nodeDispose)
          return;
        nodeDispose = ctx.slots.register({
          name: "conversation.chat.node",
          key: "assistant-step",
          priority: -1,
          inject: (sessionId) => ({ remote, sessionId, sessions })
        }, TavernAssistantNode);
      } else if (nodeDispose) {
        nodeDispose();
        nodeDispose = void 0;
      }
    };
    const sync = () => applyNode(isCurrentTavernSession(ctx.sessions.list));
    if (typeof ctx.slots.inject === "function") {
      return ctx.slots.inject("conversation.chat.node", () => {
        const unsub2 = ctx.sessions.list.subscribe(sync);
        sync();
        return () => {
          unsub2();
          applyNode(false);
        };
      });
    }
    const unsub = ctx.sessions.list.subscribe(sync);
    sync();
    return () => {
      unsub();
      applyNode(false);
    };
  }, "dsh-tavern: assistant-step");
}

    return module.exports;
  }
});
