window.__ModuleLoader__.load({ id: "@dsh-cline/host-services", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/onboarding.tsx
var import_react2 = require("react");

// src/client/ssy-models.tsx
var import_react = require("react");

// src/client/shared.ts
var SSY_KEY_REF = "SHENGSUANYUN_API_KEY";
var SSY_BASE_URL = "https://router.shengsuanyun.com/api/v1";
var SSY_SIGNUP_URL = "https://console.shengsuanyun.com/user/overview/?from=CH_L5K542DT";
var SSY_ROUTES = {
  chat: "shengsuanyun",
  responses: "shengsuanyun-responses",
  messages: "shengsuanyun-messages"
};
function ssyRouteProfiles() {
  return {
    [SSY_ROUTES.chat]: {
      displayName: "\u80DC\u7B97\u4E91",
      api: "openai-completions",
      baseURL: SSY_BASE_URL,
      apiKeyEnv: SSY_KEY_REF,
      models: []
    },
    [SSY_ROUTES.responses]: {
      displayName: "\u80DC\u7B97\u4E91 (Responses)",
      api: "openai-responses",
      baseURL: SSY_BASE_URL,
      apiKeyEnv: SSY_KEY_REF,
      models: []
    },
    [SSY_ROUTES.messages]: {
      displayName: "\u80DC\u7B97\u4E91 (Messages)",
      api: "anthropic-messages",
      baseURL: SSY_BASE_URL,
      apiKeyEnv: SSY_KEY_REF,
      models: []
    }
  };
}
function routeForModel(model) {
  const apis = model?.support_apis ?? [];
  if (apis.includes("/v1/chat/completions")) return SSY_ROUTES.chat;
  if (apis.includes("/v1/responses")) return SSY_ROUTES.responses;
  if (apis.includes("/v1/messages")) return SSY_ROUTES.messages;
  return SSY_ROUTES.chat;
}
async function fetchSsyModels() {
  const response = await fetch("/dsh-cline/models");
  if (!response.ok) throw new Error("\u6A21\u578B\u5217\u8868\u83B7\u53D6\u5931\u8D25\uFF08HTTP " + String(response.status) + "\uFF09");
  const body = await response.json();
  return Array.isArray(body.data) ? body.data : [];
}
async function openExternal(url) {
  try {
    const response = await fetch("/dsh-cline/open-external", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    });
    if (response.ok) return;
  } catch {
  }
  window.open(url, "_blank", "noopener");
}
async function readVscodeConfig(key) {
  const response = await fetch("/dsh-cline/vscode-config?key=" + encodeURIComponent(key));
  if (!response.ok) throw new Error("\u8BFB\u53D6 VS Code \u914D\u7F6E\u5931\u8D25\uFF08HTTP " + String(response.status) + "\uFF09");
  const body = await response.json();
  return body.value;
}
async function writeVscodeConfig(key, value) {
  const response = await fetch("/dsh-cline/vscode-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value })
  });
  if (!response.ok) {
    throw new Error("\u5199\u5165 VS Code \u914D\u7F6E\u5931\u8D25\uFF08HTTP " + String(response.status) + "\uFF09");
  }
}
function pathOf(value, path) {
  let node = value;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return void 0;
    node = node[key];
  }
  return node;
}
async function readDefaultModel(api) {
  const described = await api.settings.describe({});
  if (!described.result.ok) throw new Error(described.result.error.message);
  const ns = described.result.value.namespaces.find((n) => n.ns === "agent-default-model");
  const value = ns?.value;
  if (typeof value !== "object" || value === null) return void 0;
  const provider = value.provider;
  const model = value.model;
  if (typeof provider !== "string" || typeof model !== "string") return void 0;
  return { provider, model };
}
async function saveSsyModel(api, model) {
  const described = await api.settings.describe({});
  if (!described.result.ok) return described.result.error.message;
  const llmNs = described.result.value.namespaces.find((ns) => ns.ns === "llm-pi-ai");
  const defaultNs = described.result.value.namespaces.find((ns) => ns.ns === "agent-default-model");
  const revision = llmNs?.revision;
  const ops = [];
  for (const [route, profile] of Object.entries(ssyRouteProfiles())) {
    const existing = pathOf(llmNs?.value, ["providers", route]);
    const base = typeof existing === "object" && existing !== null ? existing : {};
    ops.push({
      op: "set",
      path: ["providers", route],
      value: { ...base, ...profile, models: [{ id: model.id, contextWindow: model.context_window, maxTokens: model.max_tokens }] }
    });
  }
  const mutate = await api.settings.mutate({ ns: "llm-pi-ai", ops, ...revision === void 0 ? {} : { expectedRevision: revision } });
  if (!mutate.result.ok) return mutate.result.error.message;
  const defaultOps = [{
    op: "set",
    path: [],
    value: {
      ...typeof defaultNs?.value === "object" && defaultNs?.value !== null ? defaultNs.value : {},
      provider: routeForModel(model),
      model: model.id
    }
  }];
  const defaultMutate = await api.settings.mutate({ ns: "agent-default-model", ops: defaultOps });
  if (!defaultMutate.result.ok) return defaultMutate.result.error.message;
  return void 0;
}
async function saveSsySetup(api, apiKey, model) {
  const described = await api.settings.describe({});
  if (!described.result.ok) return described.result.error.message;
  const llmNs = described.result.value.namespaces.find((ns) => ns.ns === "llm-pi-ai");
  const defaultNs = described.result.value.namespaces.find((ns) => ns.ns === "agent-default-model");
  const revision = llmNs?.revision;
  const ops = [];
  for (const [route, profile] of Object.entries(ssyRouteProfiles())) {
    const existing = pathOf(llmNs?.value, ["providers", route]);
    const base = typeof existing === "object" && existing !== null ? existing : {};
    ops.push({
      op: "set",
      path: ["providers", route],
      value: { ...base, ...profile, models: [{ id: model.id, contextWindow: model.context_window, maxTokens: model.max_tokens }] }
    });
  }
  const mutate = await api.settings.mutate({ ns: "llm-pi-ai", ops, ...revision === void 0 ? {} : { expectedRevision: revision } });
  if (!mutate.result.ok) return mutate.result.error.message;
  const defaultOps = [{
    op: "set",
    path: [],
    value: {
      ...typeof defaultNs?.value === "object" && defaultNs?.value !== null ? defaultNs.value : {},
      provider: routeForModel(model),
      model: model.id
    }
  }];
  const defaultMutate = await api.settings.mutate({ ns: "agent-default-model", ops: defaultOps });
  if (!defaultMutate.result.ok) return defaultMutate.result.error.message;
  const stored = await api.credentials.set({ ref: SSY_KEY_REF, value: apiKey });
  if (!stored.result.ok) return stored.result.error.message;
  return void 0;
}
async function probeProviders(api) {
  const [providersResponse, settingsResponse] = await Promise.all([
    api.llm.providers({}),
    api.settings.describe({})
  ]);
  if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message);
  if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message);
  const namespaces = new Map(settingsResponse.result.value.namespaces.map((ns) => [ns.ns, ns]));
  const refs = /* @__PURE__ */ new Set([SSY_KEY_REF]);
  const usable = (provider, ns, path) => {
    const profile = pathOf(namespaces.get(ns)?.value, path);
    const ref = typeof profile === "object" && profile !== null ? profile.apiKeyEnv : void 0;
    const keyRef = typeof ref === "string" && ref.length > 0 ? ref : void 0;
    if (keyRef !== void 0) refs.add(keyRef);
    return keyRef === void 0;
  };
  let anyUsable = false;
  for (const entry of providersResponse.result.value.providers) {
    if (!entry.active) continue;
    const noKeyNeeded = usable(entry.provider, entry.settingsNs, entry.settingsPath);
    if (noKeyNeeded === true) {
      anyUsable = true;
      break;
    }
  }
  const credentialsResponse = await api.credentials.describe({ refs: [...refs] });
  if (!credentialsResponse.result.ok) throw new Error(credentialsResponse.result.error.message);
  const credentials = credentialsResponse.result.value.credentials;
  if (!anyUsable) {
    anyUsable = providersResponse.result.value.providers.some((entry) => {
      if (!entry.active) return false;
      const profile = pathOf(namespaces.get(entry.settingsNs)?.value, entry.settingsPath);
      const ref = typeof profile === "object" && profile !== null ? profile.apiKeyEnv : void 0;
      const keyRef = typeof ref === "string" && ref.length > 0 ? ref : void 0;
      return keyRef === void 0 || credentials[keyRef]?.configured === true;
    });
  }
  return { anyUsable, ssyKeyed: credentials[SSY_KEY_REF]?.configured === true };
}
async function declareCustomProvider(api, route, displayName, apiKind, baseURL, key) {
  const keyRef = deriveKeyRef(route);
  const described = await api.settings.describe({});
  if (!described.result.ok) return described.result.error.message;
  const ns = described.result.value.namespaces.find((n) => n.ns === "llm-pi-ai");
  const existing = pathOf(ns?.value, ["providers", route]);
  if (existing !== void 0) return "\u4F9B\u5E94\u5546 " + route + " \u5DF2\u5B58\u5728";
  const revision = ns?.revision;
  const mutate = await api.settings.mutate({
    ns: "llm-pi-ai",
    ops: [{
      op: "set",
      path: ["providers", route],
      value: { displayName, api: apiKind, baseURL, apiKeyEnv: keyRef }
    }],
    ...revision === void 0 ? {} : { expectedRevision: revision }
  });
  if (!mutate.result.ok) return mutate.result.error.message;
  if (key.trim() !== "") {
    const stored = await api.credentials.set({ ref: keyRef, value: key.trim() });
    if (!stored.result.ok) return stored.result.error.message;
  }
  return void 0;
}
async function readProviderRows(api) {
  const [providersResponse, settingsResponse, catalogResponse] = await Promise.all([
    api.llm.providers({}),
    api.settings.describe({}),
    fetch("/dsh-cline/catalog").then((r) => r.ok ? r.json() : { models: {} }).catch(() => ({ models: {} }))
  ]);
  if (!providersResponse.result.ok) return { error: providersResponse.result.error.message };
  if (!settingsResponse.result.ok) return { error: settingsResponse.result.error.message };
  const namespaces = new Map(settingsResponse.result.value.namespaces.map((ns) => [ns.ns, ns]));
  const ssyRoutes = new Set(Object.values(SSY_ROUTES));
  const rows = [];
  const refs = /* @__PURE__ */ new Set();
  for (const entry of providersResponse.result.value.providers) {
    if (ssyRoutes.has(entry.provider)) continue;
    const catalogModels = catalogResponse.models?.[entry.provider] ?? [];
    const ns = namespaces.get(entry.settingsNs);
    const profile = ns === void 0 ? void 0 : pathOf(ns.value, entry.settingsPath);
    const inProviders = entry.settingsPath.length > 0 && profile !== void 0;
    if (!inProviders) continue;
    const configured = ns !== void 0 && profile !== void 0;
    const removable = ns !== void 0 && entry.settingsPath.length > 0 && hasPathOf(ns.user, entry.settingsPath) && !hasPathOf(ns.base, entry.settingsPath);
    const named = typeof profile === "object" && profile !== null ? profile.apiKeyEnv : void 0;
    const keyRef = typeof named === "string" && named.length > 0 ? named : deriveKeyRef(entry.provider);
    refs.add(keyRef);
    rows.push({
      provider: entry.provider,
      displayName: entry.displayName,
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath,
      configured,
      removable,
      keyRef,
      keyConfigured: void 0,
      catalogModels,
      declared: true
    });
  }
  try {
    const credentialsResponse = await api.credentials.describe({ refs: [...refs] });
    if (credentialsResponse.result.ok) {
      const credentials = credentialsResponse.result.value.credentials;
      for (const row of rows) row.keyConfigured = credentials[row.keyRef]?.configured === true;
    }
  } catch {
  }
  return { rows };
}
function hasPathOf(value, path) {
  return pathOf(value, path) !== void 0;
}
async function saveProviderKey(api, row, key, model) {
  if (row.settingsNs === "llm-pi-ai" && row.settingsPath.length > 0) {
    const described = await api.settings.describe({});
    if (!described.result.ok) return described.result.error.message;
    const ns = described.result.value.namespaces.find((n) => n.ns === "llm-pi-ai");
    const existing = pathOf(ns?.value, row.settingsPath);
    const base = typeof existing === "object" && existing !== null ? existing : {};
    const ops = [{
      op: "set",
      path: [...row.settingsPath],
      value: {
        ...base,
        apiKeyEnv: row.keyRef,
        ...model === void 0 ? {} : { models: [{ id: model }] }
      }
    }];
    const revision = ns?.revision;
    const mutate = await api.settings.mutate({
      ns: "llm-pi-ai",
      ops,
      ...revision === void 0 ? {} : { expectedRevision: revision }
    });
    if (!mutate.result.ok) return mutate.result.error.message;
  }
  const stored = await api.credentials.set({ ref: row.keyRef, value: key });
  if (!stored.result.ok) return stored.result.error.message;
  return void 0;
}
async function removeProviderRow(api, row) {
  try {
    if (row.keyConfigured === true) {
      const credential = await api.credentials.unset({ ref: row.keyRef });
      if (!credential.result.ok) return credential.result.error.message;
    }
    const mutate = await api.settings.mutate({
      ns: row.settingsNs,
      ops: [{ op: "unset", path: [...row.settingsPath] }]
    });
    if (!mutate.result.ok) return mutate.result.error.message;
  } catch (error) {
    return String(error);
  }
  return void 0;
}
async function fetchMcpServers() {
  const response = await fetch("/dsh-cline/mcp");
  if (!response.ok) throw new Error("MCP \u914D\u7F6E\u8BFB\u53D6\u5931\u8D25\uFF08HTTP " + String(response.status) + "\uFF09");
  const body = await response.json();
  return Object.entries(body.servers ?? {}).map(([name, entry]) => ({ ...entry, name }));
}
async function writeMcpServers(servers) {
  const response = await fetch("/dsh-cline/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ servers })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("MCP \u914D\u7F6E\u4FDD\u5B58\u5931\u8D25\uFF08HTTP " + String(response.status) + "\uFF09" + (detail === "" ? "" : "\uFF1A" + detail));
  }
}
async function restartDshService() {
  const response = await fetch("/dsh-cline/restart", { method: "POST" });
  if (!response.ok) {
    throw new Error("\u91CD\u542F\u8BF7\u6C42\u5931\u8D25\uFF08HTTP " + String(response.status) + "\uFF09\u2014 \u6865\u672A\u8FDE\u63A5\u65F6\u8BF7\u5728 VS Code \u4F7F\u7528\u300CDSH Cline: \u91CD\u542F DSH \u670D\u52A1\u300D");
  }
}
function deriveKeyRef(provider) {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

// src/client/ssy-models.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function SsyModelSelect(props) {
  const { value, onChange, compact = false } = props;
  const [models, setModels] = (0, import_react.useState)([]);
  const [error, setError] = (0, import_react.useState)(void 0);
  const [filter, setFilter] = (0, import_react.useState)("");
  (0, import_react.useEffect)(() => {
    let cancelled = false;
    void fetchSsyModels().then(
      (list) => {
        if (!cancelled) setModels(list);
      },
      (err) => {
        if (!cancelled) setError(String(err));
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const grouped = (0, import_react.useMemo)(() => {
    const needle = filter.trim().toLowerCase();
    const matched = models.filter((m) => needle === "" || m.id.toLowerCase().includes(needle) || (m.name ?? "").toLowerCase().includes(needle) || (m.company ?? "").toLowerCase().includes(needle));
    const groups = /* @__PURE__ */ new Map();
    for (const model of matched) {
      const key = model.company ?? "\u5176\u4ED6";
      const bucket = groups.get(key) ?? [];
      bucket.push(model);
      groups.set(key, bucket);
    }
    return [...groups.entries()];
  }, [models, filter]);
  const selected = models.find((m) => m.id === value);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshc-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "dshc-label", children: "\u6A21\u578B\uFF08\u5171 " + String(models.length) + " \u4E2A\uFF0C\u8F93\u5165\u8FC7\u6EE4\uFF09" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        className: "dshc-input dshc-model-filter",
        value: filter,
        placeholder: "\u6309\u540D\u79F0/\u5382\u5546\u8FC7\u6EE4\uFF0C\u5982 deepseek\u3001claude",
        onChange: (e) => {
          setFilter(e.target.value);
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "select",
      {
        className: "dshc-select",
        size: compact ? 6 : 8,
        value,
        onChange: (e) => {
          const next = models.find((m) => m.id === e.target.value);
          if (next !== void 0) onChange(next);
        },
        children: [
          error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: error }),
          error === void 0 && models.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u6A21\u578B\u5217\u8868\u52A0\u8F7D\u4E2D\u2026" }),
          grouped.map(([company, list]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("optgroup", { label: company, children: list.map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: m.id, children: [
            m.id,
            m.context_window !== void 0 ? " \xB7 " + String(Math.round(m.context_window / 1e3)) + "k" : ""
          ] }, m.id)) }, company))
        ]
      }
    ),
    selected !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "dshc-hint", children: [
      selected.name ?? selected.id,
      selected.context_window !== void 0 ? " \xB7 \u4E0A\u4E0B\u6587 " + String(selected.context_window) : "",
      selected.pricing?.input_price !== void 0 ? " \xB7 \xA5" + String(selected.pricing.input_price) + "/\u767E\u4E07\u8F93\u5165" : ""
    ] })
  ] });
}

// src/client/onboarding.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
function SsyOnboarding(props) {
  const { complete, api } = props;
  const [phase, setPhase] = (0, import_react2.useState)("loading");
  const [apiKey, setApiKey] = (0, import_react2.useState)("");
  const [selected, setSelected] = (0, import_react2.useState)(void 0);
  const [error, setError] = (0, import_react2.useState)(void 0);
  (0, import_react2.useEffect)(() => {
    let cancelled = false;
    void probeProviders(api).then(
      ({ anyUsable }) => {
        if (cancelled) return;
        if (anyUsable) {
          setPhase("done");
          complete();
        } else {
          setPhase("ask");
        }
      },
      (err) => {
        if (cancelled) return;
        setPhase("ask");
        setError(String(err));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, complete]);
  const save = async () => {
    const key = apiKey.trim();
    if (key === "") {
      setError("\u8BF7\u5148\u586B\u5165\u80DC\u7B97\u4E91 API Key");
      return;
    }
    if (selected === void 0) {
      setError("\u8BF7\u9009\u62E9\u4E00\u4E2A\u6A21\u578B");
      return;
    }
    setPhase("saving");
    setError(void 0);
    try {
      const failure = await saveSsySetup(api, key, selected);
      if (failure !== void 0) {
        setError(failure);
        setPhase("ask");
        return;
      }
      setPhase("done");
      complete();
    } catch (err) {
      setError(String(err));
      setPhase("ask");
    }
  };
  if (phase !== "ask" && phase !== "saving") return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshc-modal", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshc-modal-card", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { children: "\u6B22\u8FCE\u4F7F\u7528 DSH Cline" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshc-sub", children: "\u914D\u7F6E\u9ED8\u8BA4\u4F9B\u5E94\u5546\u300C\u80DC\u7B97\u4E91\u300D\u540E\u5373\u53EF\u5F00\u59CB\u3002\u586B\u5165 API Key \u5E76\u9009\u62E9\u4E00\u4E2A\u6A21\u578B\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshc-field", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { htmlFor: "dshc-key", children: "\u80DC\u7B97\u4E91 API Key" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshc-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            id: "dshc-key",
            className: "dshc-input",
            type: "password",
            value: apiKey,
            placeholder: "sk-...",
            autoFocus: true,
            onChange: (e) => {
              setApiKey(e.target.value);
            },
            onKeyDown: (e) => {
              if (e.key === "Enter" && phase === "ask") void save();
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshc-btn ghost", onClick: () => {
          void openExternal(SSY_SIGNUP_URL);
        }, children: "\u83B7\u53D6 API Key" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshc-hint", children: "\u70B9\u51FB\u6309\u94AE\u524D\u5F80\u80DC\u7B97\u4E91\u5B98\u7F51\u6CE8\u518C\u9886\u53D6\uFF08\u6D4F\u89C8\u5668\u6253\u5F00\uFF09\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SsyModelSelect, { value: selected?.id ?? "", onChange: setSelected, compact: true }),
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshc-error", children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshc-actions", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshc-btn ghost", disabled: phase === "saving", onClick: complete, children: "\u7A0D\u540E\u914D\u7F6E" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshc-btn", disabled: phase === "saving", onClick: () => {
        void save();
      }, children: phase === "saving" ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u5E76\u5F00\u59CB" })
    ] })
  ] }) });
}

// src/client/section.tsx
var import_react3 = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
var CHECKPOINT_LABELS = {
  "off": "\u5173\u95ED",
  "edit-only": "\u6BCF\u6B21\u7F16\u8F91\u524D",
  "all": "\u6240\u6709\u5DE5\u5177\u8C03\u7528\u524D"
};
function DshClineSection(props) {
  const { api } = props;
  const [diffOnEdit, setDiffOnEdit] = (0, import_react3.useState)(void 0);
  const [diffBusy, setDiffBusy] = (0, import_react3.useState)(false);
  const [checkpointAuto, setCheckpointAuto] = (0, import_react3.useState)(void 0);
  const [ssyKeyed, setSsyKeyed] = (0, import_react3.useState)(void 0);
  const [error, setError] = (0, import_react3.useState)(void 0);
  const [health, setHealth] = (0, import_react3.useState)(void 0);
  const [mcpRows, setMcpRows] = (0, import_react3.useState)(void 0);
  const [mcpBusy, setMcpBusy] = (0, import_react3.useState)(false);
  const [mcpAdding, setMcpAdding] = (0, import_react3.useState)(false);
  const [mcpName, setMcpName] = (0, import_react3.useState)("");
  const [mcpTransport, setMcpTransport] = (0, import_react3.useState)("stdio");
  const [mcpCommand, setMcpCommand] = (0, import_react3.useState)("");
  const [mcpUrl, setMcpUrl] = (0, import_react3.useState)("");
  const [restartBusy, setRestartBusy] = (0, import_react3.useState)(false);
  const [restartNote, setRestartNote] = (0, import_react3.useState)(void 0);
  const reloadMcp = (0, import_react3.useCallback)(() => {
    return fetchMcpServers().then(
      (rows) => {
        setMcpRows(rows);
      },
      (err) => {
        setError(String(err));
      }
    );
  }, []);
  (0, import_react3.useEffect)(() => {
    let cancelled = false;
    void readVscodeConfig("diffOnEdit").then(
      (v) => {
        if (!cancelled) setDiffOnEdit(v !== false);
      },
      (err) => {
        if (!cancelled) setError(String(err));
      }
    );
    void api.settings.describe({}).then(
      (response) => {
        if (cancelled || !response.result.ok) return;
        const ns = response.result.value.namespaces.find((n) => n.ns === "dsh-cline-host-services");
        const value = ns?.value;
        const mode = typeof value === "object" && value !== null ? value.checkpointAuto : void 0;
        if (mode === "off" || mode === "edit-only" || mode === "all") setCheckpointAuto(mode);
      },
      () => {
      }
    );
    void probeProviders(api).then(
      ({ ssyKeyed: ssyKeyed2 }) => {
        if (!cancelled) setSsyKeyed(ssyKeyed2);
      },
      () => {
      }
    );
    void fetch("/dsh-cline/health").then(
      async (response) => {
        if (cancelled) return;
        try {
          const body = await response.json();
          if (body.bridge === "up") setHealth("\u6865\u5DF2\u8FDE\u63A5 \xB7 \u6269\u5C55 v" + String(body.extensionVersion ?? "?"));
          else setHealth("\u6865\u672A\u8FDE\u63A5\uFF08" + String(body.error ?? "bridge down") + "\uFF09");
        } catch {
          setHealth("\u6865\u672A\u8FDE\u63A5");
        }
      },
      () => {
        if (!cancelled) setHealth("\u6865\u672A\u8FDE\u63A5");
      }
    );
    void reloadMcp();
    return () => {
      cancelled = true;
    };
  }, [api, reloadMcp]);
  const toggleDiff = async () => {
    if (diffOnEdit === void 0 || diffBusy) return;
    setDiffBusy(true);
    setError(void 0);
    try {
      const next = !diffOnEdit;
      await writeVscodeConfig("diffOnEdit", next);
      setDiffOnEdit(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setDiffBusy(false);
    }
  };
  const setCheckpoint = async (next) => {
    setCheckpointAuto(next);
    setError(void 0);
    try {
      const described = await api.settings.describe({});
      if (!described.result.ok) throw new Error(described.result.error.message);
      const ns = described.result.value.namespaces.find((n) => n.ns === "dsh-cline-host-services");
      const response = await api.settings.mutate({
        ns: "dsh-cline-host-services",
        ops: [{ op: "set", path: ["checkpointAuto"], value: next }],
        ...ns?.revision === void 0 ? {} : { expectedRevision: ns.revision }
      });
      if (!response.result.ok) throw new Error(response.result.error.message);
    } catch (err) {
      setError(String(err));
    }
  };
  const writeMcp = async (mutate) => {
    if (mcpRows === void 0 || mcpBusy) return;
    setMcpBusy(true);
    setError(void 0);
    try {
      const servers = {};
      for (const row of mcpRows) {
        const { name, ...entry } = row;
        servers[name] = entry;
      }
      mutate(servers);
      await writeMcpServers(servers);
      await reloadMcp();
    } catch (err) {
      setError(String(err));
    } finally {
      setMcpBusy(false);
    }
  };
  const addMcp = async () => {
    const name = mcpName.trim();
    if (name === "" || mcpBusy) return;
    if (mcpTransport === "stdio" && mcpCommand.trim() === "") {
      setError("stdio \u670D\u52A1\u5668\u9700\u8981 command");
      return;
    }
    if (mcpTransport === "streamable-http" && !/^https?:\/\//.test(mcpUrl.trim())) {
      setError("http \u670D\u52A1\u5668\u9700\u8981\u4EE5 http(s) \u5F00\u5934\u7684 url");
      return;
    }
    await writeMcp((servers) => {
      servers[name] = mcpTransport === "stdio" ? { transport: "stdio", command: mcpCommand.trim() } : { transport: "streamable-http", url: mcpUrl.trim() };
    });
    setMcpAdding(false);
    setMcpName("");
    setMcpCommand("");
    setMcpUrl("");
  };
  const restart = async () => {
    if (restartBusy) return;
    setRestartBusy(true);
    setRestartNote("\u91CD\u542F\u8BF7\u6C42\u5DF2\u53D1\u9001\uFF0C\u7B49\u5F85\u670D\u52A1\u6062\u590D\u2026");
    setError(void 0);
    try {
      await restartDshService();
      const deadline = Date.now() + 18e4;
      for (; ; ) {
        await new Promise((resolve) => {
          setTimeout(resolve, 3e3);
        });
        if (Date.now() > deadline) break;
        try {
          const response = await fetch("/dsh-cline/health");
          if (response.ok) break;
        } catch {
        }
      }
      setRestartNote("\u670D\u52A1\u5DF2\u6062\u590D\uFF0C\u6B63\u5728\u5237\u65B0\u9875\u9762\u2026");
      setTimeout(() => {
        window.location.reload();
      }, 800);
    } catch (err) {
      setError(String(err));
      setRestartNote(void 0);
    } finally {
      setRestartBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshc-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("h3", { children: "\u7F16\u8F91 Diff \u955C\u50CF" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-desc", children: "DSH \u4FEE\u6539\u6587\u4EF6\u540E\uFF0C\u81EA\u52A8\u5728 VS Code \u539F\u751F diff \u7F16\u8F91\u5668\u4E2D\u5448\u73B0\u53D8\u66F4\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshc-toggle", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshc-status", children: diffOnEdit === void 0 ? "\u8BFB\u53D6\u4E2D\u2026" : diffOnEdit ? "\u5DF2\u5F00\u542F" : "\u5DF2\u5173\u95ED" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "button",
          {
            type: "button",
            className: "dshc-switch",
            role: "switch",
            "aria-checked": diffOnEdit === true,
            disabled: diffOnEdit === void 0 || diffBusy,
            onClick: () => {
              void toggleDiff();
            }
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshc-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("h3", { children: "\u68C0\u67E5\u70B9\u81EA\u52A8\u5FEB\u7167" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-desc", children: "\u5728 DSH \u5DE5\u5177\u8C03\u7528\u524D\u81EA\u52A8\u843D\u68C0\u67E5\u70B9\uFF08\u5F71\u5B50 git \u4ED3\u5E93\uFF0C\u53EF\u5728\u547D\u4EE4\u9762\u677F\u6062\u590D\uFF09\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dshc-seg", children: Object.keys(CHECKPOINT_LABELS).map((mode) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "button",
        {
          type: "button",
          className: checkpointAuto === mode ? "on" : "",
          disabled: checkpointAuto === void 0,
          onClick: () => {
            void setCheckpoint(mode);
          },
          children: CHECKPOINT_LABELS[mode]
        },
        mode
      )) }),
      checkpointAuto === void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-hint", children: "\u4FDD\u6301\u9ED8\u8BA4\uFF08\u6BCF\u6B21\u7F16\u8F91\u524D\uFF09\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshc-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("h3", { children: "MCP \u670D\u52A1\u5668" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-desc", children: "\u58F0\u660E\u5728 ~/.dsh-cline/dsh-cline/mcp.json\uFF1B\u53D8\u66F4\u5728\u4E0B\u6B21 DSH \u542F\u52A8\u65F6\u751F\u6548\u3002" }),
      mcpRows === void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-status", children: "\u8BFB\u53D6\u4E2D\u2026" }),
      mcpRows !== void 0 && mcpRows.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-hint", children: "\u5C1A\u672A\u914D\u7F6E\u4EFB\u4F55 MCP \u670D\u52A1\u5668\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("ul", { className: "dshc-list", children: (mcpRows ?? []).map((row) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("li", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "span",
          {
            className: row.disabled === true ? "dshc-dot unknown" : "dshc-dot ok",
            title: row.disabled === true ? "\u5DF2\u505C\u7528" : "\u5DF2\u542F\u7528"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "dshc-list-main", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: row.name }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dshc-list-sub", children: row.transport === "stdio" ? String(row.command ?? "") : String(row.url ?? "") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "button",
          {
            type: "button",
            className: "dshc-btn small ghost",
            disabled: mcpBusy,
            onClick: () => {
              void writeMcp((servers) => {
                servers[row.name] = { ...servers[row.name], disabled: row.disabled !== true };
              });
            },
            children: row.disabled === true ? "\u542F\u7528" : "\u505C\u7528"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "button",
          {
            type: "button",
            className: "dshc-btn small danger",
            disabled: mcpBusy,
            onClick: () => {
              void writeMcp((servers) => {
                delete servers[row.name];
              });
            },
            children: "\u79FB\u9664"
          }
        )
      ] }, row.name)) }),
      mcpAdding ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshc-row", style: { marginBottom: 6 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "input",
            {
              className: "dshc-input",
              placeholder: "\u540D\u79F0\uFF08\u5982 everything\uFF09",
              value: mcpName,
              onChange: (e) => {
                setMcpName(e.target.value);
              }
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "select",
            {
              className: "dshc-select",
              style: { flex: "none", width: "min(130px, 45%)" },
              value: mcpTransport,
              onChange: (e) => {
                setMcpTransport(e.target.value === "streamable-http" ? "streamable-http" : "stdio");
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "stdio", children: "stdio" }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "streamable-http", children: "HTTP" })
              ]
            }
          )
        ] }),
        mcpTransport === "stdio" ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "input",
          {
            className: "dshc-input",
            placeholder: "command\uFF08\u5982 npx -y @modelcontextprotocol/server-everything\uFF0C\u53C2\u6570\u7528\u7A7A\u683C\u5206\u9694\uFF09",
            value: mcpCommand,
            onChange: (e) => {
              setMcpCommand(e.target.value);
            }
          }
        ) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "input",
          {
            className: "dshc-input",
            placeholder: "url\uFF08http(s)://\u2026\uFF09",
            value: mcpUrl,
            onChange: (e) => {
              setMcpUrl(e.target.value);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshc-actions", style: { marginTop: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dshc-btn ghost", disabled: mcpBusy, onClick: () => {
            setMcpAdding(false);
          }, children: "\u53D6\u6D88" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dshc-btn", disabled: mcpBusy, onClick: () => {
            void addMcp();
          }, children: "\u6DFB\u52A0" })
        ] })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dshc-btn ghost", disabled: mcpBusy, onClick: () => {
        setMcpAdding(true);
      }, children: "+ \u6DFB\u52A0 MCP \u670D\u52A1\u5668" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshc-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("h3", { children: "DSH \u670D\u52A1" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-desc", children: "\u7EC8\u7AEF\u5E38\u9A7B\u7684 dsh web \u8FDB\u7A0B\uFF1A\u5065\u5EB7\u68C0\u67E5\u3001\u5361\u6B7B/\u914D\u7F6E\u5F02\u5E38\u65F6\u539F\u5730\u91CD\u542F\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-status", children: health ?? "\u68C0\u6D4B\u4E2D\u2026" }),
      restartNote !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-status ok", children: restartNote }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dshc-actions", style: { marginTop: 8 }, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dshc-btn", disabled: restartBusy, onClick: () => {
        void restart();
      }, children: restartBusy ? "\u91CD\u542F\u4E2D\u2026" : "\u91CD\u542F DSH \u670D\u52A1" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-hint", children: "\u91CD\u542F\u4F1A\u4E2D\u65AD\u5F53\u524D\u4F1A\u8BDD\u8FDE\u63A5\uFF0C\u670D\u52A1\u6062\u590D\u540E\u672C\u9875\u81EA\u52A8\u5237\u65B0\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshc-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("h3", { children: "\u5173\u4E8E" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "dshc-status", children: [
        "\u9ED8\u8BA4\u4F9B\u5E94\u5546\uFF1A\u80DC\u7B97\u4E91 \xB7 ",
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: ssyKeyed === void 0 ? "" : ssyKeyed ? "dshc-status ok" : "dshc-status bad", children: ssyKeyed === void 0 ? "\u72B6\u6001\u672A\u77E5" : ssyKeyed ? "API Key \u5DF2\u914D\u7F6E" : "API Key \u672A\u914D\u7F6E" }),
        "\uFF08\u5728\u300C\u6A21\u578B\u300D\u9875\u914D\u7F6E\uFF09"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-hint", children: "DSH Cline\uFF1ADSH \u7EC8\u7AEF\u5E38\u9A7B\u8FD0\u884C + VS Code \u6DF1\u5EA6\u96C6\u6210\uFF08\u65B9\u6848 F\uFF09\u3002" })
    ] }),
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshc-error", children: error })
  ] });
}

// src/client/models-section.tsx
var import_react4 = require("react");
var import_jsx_runtime4 = require("react/jsx-runtime");
var CUSTOM_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"];
function defaultModelLabel(def) {
  if (def === void 0) return "\u672A\u8BBE\u7F6E";
  return def.provider + " \xB7 " + def.model;
}
function DshClineModelsSection(props) {
  const { api } = props;
  if (api === void 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Loaded, { api });
}
function Loaded({ api }) {
  const [loading, setLoading] = (0, import_react4.useState)(true);
  const [loadError, setLoadError] = (0, import_react4.useState)(void 0);
  const [incomplete, setIncomplete] = (0, import_react4.useState)(false);
  const [ssyKeyed, setSsyKeyed] = (0, import_react4.useState)(void 0);
  const [defaultModel, setDefaultModel] = (0, import_react4.useState)(void 0);
  const [rows, setRows] = (0, import_react4.useState)([]);
  const [keyDraft, setKeyDraft] = (0, import_react4.useState)("");
  const [selected, setSelected] = (0, import_react4.useState)(void 0);
  const [busy, setBusy] = (0, import_react4.useState)(false);
  const [error, setError] = (0, import_react4.useState)(void 0);
  const [savedNote, setSavedNote] = (0, import_react4.useState)(void 0);
  const [editingRow, setEditingRow] = (0, import_react4.useState)(void 0);
  const [rowKeyDraft, setRowKeyDraft] = (0, import_react4.useState)("");
  const [rowModel, setRowModel] = (0, import_react4.useState)("");
  const [rowBusy, setRowBusy] = (0, import_react4.useState)(false);
  const [declaring, setDeclaring] = (0, import_react4.useState)(false);
  const [declareName, setDeclareName] = (0, import_react4.useState)("");
  const [declareDisplay, setDeclareDisplay] = (0, import_react4.useState)("");
  const [declareProtocol, setDeclareProtocol] = (0, import_react4.useState)(CUSTOM_PROTOCOLS[0]);
  const [declareBase, setDeclareBase] = (0, import_react4.useState)("");
  const [declareKey, setDeclareKey] = (0, import_react4.useState)("");
  const [declareBusy, setDeclareBusy] = (0, import_react4.useState)(false);
  const reload = (0, import_react4.useCallback)(() => {
    return (async () => {
      const described = await api.settings.describe({});
      if (!described.result.ok) {
        setLoadError(described.result.error.message);
        setLoading(false);
        return;
      }
      const hasLlm = described.result.value.namespaces.some((ns) => ns.ns === "llm-pi-ai");
      setIncomplete(!hasLlm);
      const [probe, def, joined] = await Promise.all([
        probeProviders(api).catch(() => ({ anyUsable: false, ssyKeyed: void 0 })),
        readDefaultModel(api).catch(() => void 0),
        readProviderRows(api)
      ]);
      setSsyKeyed(probe.ssyKeyed);
      setDefaultModel(def);
      if (joined.error !== void 0) setLoadError(joined.error);
      else setRows(joined.rows ?? []);
      if (def !== void 0 && def.provider.startsWith("shengsuanyun")) {
        setSelected((previous) => previous?.id === def.model ? previous : { id: def.model });
      }
      setLoading(false);
    })();
  }, [api]);
  (0, import_react4.useEffect)(() => {
    void reload();
  }, [reload]);
  const save = async () => {
    if (busy || incomplete) return;
    setBusy(true);
    setError(void 0);
    setSavedNote(void 0);
    try {
      const key = keyDraft.trim();
      if (selected === void 0) {
        setError("\u8BF7\u9009\u62E9\u4E00\u4E2A\u6A21\u578B");
        return;
      }
      let failure;
      if (key !== "") {
        failure = await saveSsySetup(api, key, selected);
      } else if (ssyKeyed === true) {
        failure = await saveSsyModel(api, selected);
      } else {
        setError("\u8BF7\u5148\u586B\u5165\u80DC\u7B97\u4E91 API Key");
        return;
      }
      if (failure !== void 0) {
        setError(failure);
        return;
      }
      setKeyDraft("");
      setSavedNote(key !== "" ? "\u5DF2\u4FDD\u5B58\uFF1A\u80DC\u7B97\u4E91\u5DF2\u914D\u7F6E\u5E76\u8BBE\u4E3A\u9ED8\u8BA4\u4F9B\u5E94\u5546" : "\u5DF2\u4FDD\u5B58\uFF1A\u9ED8\u8BA4\u6A21\u578B\u5DF2\u66F4\u65B0");
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  const saveRowKey = async (row) => {
    if (rowBusy) return;
    const key = rowKeyDraft.trim();
    if (key === "") return;
    setRowBusy(true);
    setError(void 0);
    try {
      const failure = await saveProviderKey(api, row, key, rowModel === "" ? void 0 : rowModel);
      if (failure !== void 0) {
        setError(failure);
        return;
      }
      setEditingRow(void 0);
      setRowKeyDraft("");
      setRowModel("");
      setSavedNote("\u5DF2\u4FDD\u5B58\uFF1A" + row.displayName + " \u7684 API Key");
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setRowBusy(false);
    }
  };
  const removeRow = async (row) => {
    if (rowBusy) return;
    setRowBusy(true);
    setError(void 0);
    try {
      const failure = await removeProviderRow(api, row);
      if (failure !== void 0) {
        setError(failure);
        return;
      }
      setSavedNote("\u5DF2\u79FB\u9664\uFF1A" + row.displayName);
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setRowBusy(false);
    }
  };
  const declareProvider = async () => {
    const route = declareName.trim();
    if (route === "" || declareBusy || incomplete) return;
    if (declareBase.trim() === "" || !/^https?:\/\//.test(declareBase.trim())) {
      setError("\u81EA\u5B9A\u4E49\u4F9B\u5E94\u5546\u9700\u8981\u4EE5 http(s) \u5F00\u5934\u7684 Base URL");
      return;
    }
    setDeclareBusy(true);
    setError(void 0);
    try {
      const failure = await declareCustomProvider(
        api,
        route,
        declareDisplay.trim() === "" ? route : declareDisplay.trim(),
        declareProtocol,
        declareBase.trim(),
        declareKey
      );
      if (failure !== void 0) {
        setError(failure);
        return;
      }
      setDeclaring(false);
      setDeclareName("");
      setDeclareDisplay("");
      setDeclareBase("");
      setDeclareKey("");
      setSavedNote("\u5DF2\u58F0\u660E\u81EA\u5B9A\u4E49\u4F9B\u5E94\u5546\uFF1A" + route + "\uFF08\u53EF\u5728\u4E0A\u65B9\u5217\u8868\u914D\u7F6E Key\uFF09");
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setDeclareBusy(false);
    }
  };
  if (loading) {
    return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "dshc-empty", children: "\u52A0\u8F7D\u4E2D\u2026" });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { children: [
    loadError !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "dshc-error", children: "\u8BFB\u53D6\u5931\u8D25\uFF1A" + loadError }),
    incomplete && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "dshc-banner", children: "\u5F53\u524D DSH \u8FD0\u884C\u4E0D\u5B8C\u6574\uFF08llm-pi-ai \u672A\u6CE8\u518C\uFF09\uFF0C\u4F9B\u5E94\u5546\u914D\u7F6E\u6682\u65F6\u65E0\u6CD5\u4FDD\u5B58\u3002 \u8BF7\u5728 VS Code \u6267\u884C\u300CDSH Cline: \u91CD\u542F DSH \u670D\u52A1\u300D\uFF08\u6216\u5173\u95ED\u300CDSH Cline \u670D\u52A1\u300D\u7EC8\u7AEF\u8BA9\u63D2\u4EF6\u81EA\u52A8\u62C9\u8D77\uFF09\u540E\u91CD\u8BD5\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "dshc-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("h3", { children: [
        "\u80DC\u7B97\u4E91",
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "dshc-badge", children: "\u9ED8\u8BA4" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "dshc-desc", children: "DSH Cline \u7684\u9ED8\u8BA4\u4F9B\u5E94\u5546\uFF1A\u4E09\u4E2A\u517C\u5BB9\u63A5\u53E3\u5171\u7528\u4E00\u628A Key\u3002\u6A21\u578B\u4E0E API Key \u90FD\u53EA\u5728\u8FD9\u91CC\u914D\u7F6E\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("p", { className: ssyKeyed === void 0 ? "dshc-status" : ssyKeyed ? "dshc-status ok" : "dshc-status bad", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: ssyKeyed === void 0 ? "dshc-dot unknown" : ssyKeyed ? "dshc-dot ok" : "dshc-dot bad" }),
        ssyKeyed === void 0 ? "\u72B6\u6001\u672A\u77E5" : ssyKeyed ? "API Key \u5DF2\u914D\u7F6E" : "API Key \u672A\u914D\u7F6E",
        "\u3000\u9ED8\u8BA4\u6A21\u578B\uFF1A" + defaultModelLabel(defaultModel)
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "dshc-row", style: { marginTop: 8, marginBottom: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "input",
          {
            className: "dshc-input",
            type: "password",
            value: keyDraft,
            placeholder: ssyKeyed === true ? "\u8F93\u5165\u65B0 Key \u4EE5\u66FF\u6362\uFF08\u7559\u7A7A\u5219\u4EC5\u6539\u6A21\u578B\uFF09" : "sk-...",
            onChange: (e) => {
              setKeyDraft(e.target.value);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "dshc-btn ghost", onClick: () => {
          void openExternal(SSY_SIGNUP_URL);
        }, children: "\u83B7\u53D6 API Key" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(SsyModelSelect, { value: selected?.id ?? "", onChange: setSelected }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "dshc-actions", style: { marginTop: 12 }, children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "button",
        {
          type: "button",
          className: "dshc-btn",
          disabled: busy || incomplete || selected === void 0,
          onClick: () => {
            void save();
          },
          children: busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58"
        }
      ) }),
      savedNote !== void 0 && error === void 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "dshc-status ok", children: savedNote })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "dshc-section-title", children: "\u5176\u4ED6\u4F9B\u5E94\u5546" }),
    rows.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "dshc-hint", children: "\u6CA1\u6709\u5176\u4ED6\u4F9B\u5E94\u5546\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("ul", { className: "dshc-list", children: rows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("li", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "span",
        {
          className: row.keyConfigured === void 0 ? "dshc-dot unknown" : row.keyConfigured ? "dshc-dot ok" : "dshc-dot bad",
          title: row.keyConfigured === void 0 ? "\u72B6\u6001\u672A\u77E5" : row.keyConfigured ? "API Key \u5DF2\u914D\u7F6E" : "API Key \u672A\u914D\u7F6E"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "dshc-list-main", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { children: [
          row.displayName,
          row.declared && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "dshc-badge", children: "\u81EA\u5B9A\u4E49" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "dshc-list-sub", children: row.configured ? row.keyRef : "\u672A\u914D\u7F6E \u2014 \u586B\u5165 Key \u5373\u542F\u7528" }),
        editingRow === row.provider && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { style: { marginTop: 6 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "dshc-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
              "input",
              {
                className: "dshc-input",
                type: "password",
                autoFocus: true,
                placeholder: row.keyRef,
                value: rowKeyDraft,
                onChange: (e) => {
                  setRowKeyDraft(e.target.value);
                },
                onKeyDown: (e) => {
                  if (e.key === "Enter") void saveRowKey(row);
                }
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
              "button",
              {
                type: "button",
                className: "dshc-btn small",
                disabled: rowBusy || rowKeyDraft.trim() === "",
                onClick: () => {
                  void saveRowKey(row);
                },
                children: "\u4FDD\u5B58"
              }
            )
          ] }),
          row.catalogModels.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
            "select",
            {
              className: "dshc-select",
              style: { marginTop: 6 },
              value: rowModel,
              onChange: (e) => {
                setRowModel(e.target.value);
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("option", { value: "", children: "\u6A21\u578B\uFF08\u53EF\u9009\uFF0C\u4FDD\u6301\u76EE\u5F55\u9ED8\u8BA4\uFF09" }),
                row.catalogModels.map((id) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("option", { value: id, children: id }, id))
              ]
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "button",
        {
          type: "button",
          className: "dshc-btn small ghost",
          disabled: rowBusy || incomplete,
          onClick: () => {
            setEditingRow(editingRow === row.provider ? void 0 : row.provider);
            setRowKeyDraft("");
            setRowModel("");
          },
          children: editingRow === row.provider ? "\u6536\u8D77" : "\u914D\u7F6E Key"
        }
      ),
      row.removable && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "button",
        {
          type: "button",
          className: "dshc-btn small danger",
          disabled: rowBusy || incomplete,
          title: "\u79FB\u9664\u8BE5\u4F9B\u5E94\u5546\u7684\u7528\u6237\u914D\u7F6E\uFF08\u5E76\u5220\u9664\u5176 API Key\uFF09",
          onClick: () => {
            void removeRow(row);
          },
          children: "\u79FB\u9664"
        }
      )
    ] }, row.provider)) }),
    declaring ? /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "dshc-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("h3", { children: "\u58F0\u660E\u81EA\u5B9A\u4E49\u4F9B\u5E94\u5546" }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "dshc-desc", children: "\u58F0\u660E\u4E00\u6761 pi-ai \u4E0D\u77E5\u9053\u7684\u4F9B\u5E94\u5546 route\uFF08OpenAI/Anthropic \u517C\u5BB9\u63A5\u53E3\u5747\u53EF\uFF09\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "dshc-row", style: { marginBottom: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "input",
          {
            className: "dshc-input",
            placeholder: "route id\uFF08\u5C0F\u5199\u5B57\u6BCD/\u6570\u5B57/\u8FDE\u5B57\u7B26\uFF0C\u5982 my-gateway\uFF09",
            value: declareName,
            onChange: (e) => {
              setDeclareName(e.target.value);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "input",
          {
            className: "dshc-input",
            placeholder: "\u663E\u793A\u540D\uFF08\u53EF\u7559\u7A7A = route id\uFF09",
            value: declareDisplay,
            onChange: (e) => {
              setDeclareDisplay(e.target.value);
            }
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "dshc-row", style: { marginBottom: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "select",
          {
            className: "dshc-select",
            style: { flex: "none", width: "min(190px, 55%)" },
            value: declareProtocol,
            onChange: (e) => {
              setDeclareProtocol(e.target.value);
            },
            children: CUSTOM_PROTOCOLS.map((p) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("option", { value: p, children: p }, p))
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "input",
          {
            className: "dshc-input",
            placeholder: "Base URL\uFF08https://\u2026/v1\uFF09",
            value: declareBase,
            onChange: (e) => {
              setDeclareBase(e.target.value);
            }
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "input",
        {
          className: "dshc-input",
          type: "password",
          placeholder: "API Key\uFF08\u53EF\u7559\u7A7A\u7A0D\u540E\u914D\u7F6E\uFF09",
          value: declareKey,
          onChange: (e) => {
            setDeclareKey(e.target.value);
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "dshc-actions", style: { marginTop: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "dshc-btn ghost", disabled: declareBusy, onClick: () => {
          setDeclaring(false);
        }, children: "\u53D6\u6D88" }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "button",
          {
            type: "button",
            className: "dshc-btn",
            disabled: declareBusy || incomplete || declareName.trim() === "",
            onClick: () => {
              void declareProvider();
            },
            children: declareBusy ? "\u58F0\u660E\u4E2D\u2026" : "\u58F0\u660E"
          }
        )
      ] })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "dshc-btn ghost", disabled: incomplete, onClick: () => {
      setDeclaring(true);
    }, children: "+ \u58F0\u660E\u81EA\u5B9A\u4E49\u4F9B\u5E94\u5546" }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "dshc-hint", style: { marginTop: 10 }, children: "\u9AD8\u7EA7\u914D\u7F6E\uFF08\u6A21\u578B\u6E05\u5355\u7EC6\u5316\u3001\u590D\u6742\u5B57\u6BB5\uFF09\u8BF7\u76F4\u63A5\u7F16\u8F91 ~/.dsh-cline/settings.yaml\u3002" }),
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "dshc-error", children: error })
  ] });
}

// src/client/styles.ts
var CLIENT_CSS = `
.dshc-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: var(--dsw-mask-blur, rgba(0,0,0,.45)); }
.dshc-modal-card { width: min(480px, calc(100vw - 48px)); max-height: calc(100vh - 64px); overflow: auto; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 22px 24px; box-shadow: 0 12px 40px rgba(0,0,0,.25); font-family: inherit; }
.dshc-modal-card h2 { margin: 0 0 6px; font-size: 16px; color: var(--dsw-alias-label-primary); }
.dshc-modal-card p.dshc-sub { margin: 0 0 14px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshc-field { margin: 0 0 12px; }
.dshc-field > label { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 0 5px; }
.dshc-input, .dshc-select { width: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l3); border-radius: 7px; padding: 7px 10px; font-size: 13px; font-family: inherit; }
.dshc-input:focus, .dshc-select:focus { outline: 1px solid var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dshc-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dshc-row > .dshc-input, .dshc-row > .dshc-select { flex: 1; min-width: 0; }
.dshc-btn { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); border: 0; border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; white-space: nowrap; }
.dshc-btn:hover { background: var(--dsw-alias-button-primary-hover); }
.dshc-btn:disabled { opacity: .55; cursor: default; }
.dshc-btn.ghost { background: transparent; color: var(--dsw-alias-brand-primary); border: 1px solid var(--dsw-alias-brand-primary); }
.dshc-btn.ghost:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshc-btn.link { background: transparent; color: var(--dsw-alias-brand-primary); border: 0; padding: 7px 4px; text-decoration: underline; }
.dshc-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.dshc-error { margin: 8px 0 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; word-break: break-all; }
.dshc-hint { margin: 6px 0 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dshc-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 14px 16px; margin: 0 0 12px; color: var(--dsw-alias-label-primary); }
.dshc-card h3 { margin: 0 0 4px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshc-card .dshc-desc { margin: 0 0 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshc-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dshc-switch { position: relative; width: 34px; height: 19px; border-radius: 999px; border: 0; cursor: pointer; background: var(--dsw-alias-border-l3); transition: background .15s; flex: none; }
.dshc-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: left .15s; }
.dshc-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dshc-switch[aria-checked='true']::after { left: 17px; background: var(--dsw-alias-label-primary-foreground); }
.dshc-status { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshc-status.ok { color: var(--dsw-alias-state-success-primary); }
.dshc-status.bad { color: var(--dsw-alias-state-error-primary); }
.dshc-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l3); border-radius: 7px; overflow: hidden; }
.dshc-seg button { background: transparent; color: var(--dsw-alias-label-secondary); border: 0; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.dshc-seg button.on { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dshc-model-filter { margin: 0 0 6px; }
.dshc-empty { padding: 24px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dshc-badge { display: inline-block; font-size: 10px; color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-brand-primary); border-radius: 4px; padding: 1px 6px; margin-left: 6px; vertical-align: 1px; }
.dshc-banner { background: var(--dsw-alias-state-warn-label, #6b5a1e); color: var(--dsw-alias-label-primary-foreground, #fff); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 10px 12px; font-size: 12px; margin: 0 0 12px; }
.dshc-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 0; flex: none; }
.dshc-dot.ok { background: var(--dsw-alias-state-success-primary); }
.dshc-dot.bad { background: var(--dsw-alias-state-error-primary); }
.dshc-dot.unknown { background: var(--dsw-alias-label-tertiary); }
.dshc-list { list-style: none; margin: 0; padding: 0; }
.dshc-list > li { display: flex; align-items: center; gap: 10px; padding: 9px 12px; background: var(--dsw-alias-bg-module-platform); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; margin: 0 0 8px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshc-list .dshc-list-main { flex: 1; min-width: 0; }
.dshc-list .dshc-list-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; word-break: break-all; }
.dshc-btn.danger { background: transparent; color: var(--dsw-alias-state-error-primary); border: 1px solid var(--dsw-alias-state-error-primary); }
.dshc-btn.danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dshc-btn.small { padding: 4px 10px; font-size: 12px; }
.dshc-section-title { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin: 18px 0 8px; text-transform: uppercase; letter-spacing: .5px; }
/* Sidebar brand row re-label (hash-stable best-effort; see module doc). */
[class*='_brand'][class*='_wide'] svg { display: none; }
[class*='_brand'][class*='_wide']::after { content: 'DSH Cline'; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); letter-spacing: .2px; }
/* Resizable-window adaptation: stack rows that would overflow a narrow panel,
   and let segmented controls wrap instead of clipping. */
@media (max-width: 480px) {
  .dshc-row { flex-wrap: wrap; }
  .dshc-actions { flex-wrap: wrap; gap: 6px; }
  .dshc-btn { white-space: normal; }
  .dshc-seg { flex-wrap: wrap; }
  .dshc-modal-card { padding: 16px; }
  .dshc-modal-card h2 { font-size: 15px; }
  .dshc-list > li { flex-wrap: wrap; }
  .dshc-card { padding: 12px; }
}
`;

// src/client/clipboard.ts
function post(op, text = "") {
  try {
    window.parent.postMessage({ channel: "dsh-cline.host-service", type: "clipboard", op, text }, "*");
  } catch {
  }
}
function selectionText() {
  return window.getSelection()?.toString() ?? "";
}
function setNativeValue(input, value, caret) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(input, value);
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function insertText(text) {
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const input = el;
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? input.value.length;
    setNativeValue(input, input.value.slice(0, s) + text + input.value.slice(e), s + text.length);
  } else if (el && el.isContentEditable) {
    el.focus();
    document.execCommand("insertText", false, text);
  } else {
    document.execCommand("insertText", false, text);
  }
}
function clearSelection() {
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? el.value.length;
    setNativeValue(el, el.value.slice(0, s) + el.value.slice(e), s);
  } else {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) sel.deleteFromDocument();
  }
}
function installClipboard() {
  document.addEventListener("keydown", (ev) => {
    if (!(ev.metaKey || ev.ctrlKey)) return;
    const k = ev.key.toLowerCase();
    if (k !== "c" && k !== "v" && k !== "x" && k !== "a") return;
    ev.preventDefault();
    ev.stopPropagation();
    if (k === "a") {
      document.execCommand("selectAll");
      return;
    }
    if (k === "c") {
      post("copy", selectionText());
      return;
    }
    if (k === "x") {
      post("cut", selectionText());
      clearSelection();
      return;
    }
    post("paste");
  }, true);
  let menu = null;
  const removeMenu = () => {
    if (menu) {
      menu.remove();
      menu = null;
    }
  };
  const showMenu = (x, y) => {
    removeMenu();
    menu = document.createElement("div");
    menu.style.cssText = 'position:fixed;z-index:2147483647;background:#252530;border:1px solid #3a3a46;border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.45);font:13px system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#e8e8ec;min-width:120px;';
    const addItem = (label, fn) => {
      const b = document.createElement("div");
      b.textContent = label;
      b.style.cssText = "padding:6px 14px;border-radius:5px;cursor:pointer;white-space:nowrap;";
      b.addEventListener("mouseenter", () => {
        b.style.background = "#33323f";
      });
      b.addEventListener("mouseleave", () => {
        b.style.background = "transparent";
      });
      b.addEventListener("click", () => {
        removeMenu();
        fn();
      });
      menu.appendChild(b);
    };
    addItem("\u7C98\u8D34", () => post("paste"));
    addItem("\u590D\u5236", () => post("copy", selectionText()));
    addItem("\u526A\u5207", () => {
      post("cut", selectionText());
      clearSelection();
    });
    addItem("\u5168\u9009", () => document.execCommand("selectAll"));
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 8)) + "px";
    menu.style.top = Math.max(0, Math.min(y, window.innerHeight - rect.height - 8)) + "px";
  };
  document.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    showMenu(ev.clientX, ev.clientY);
  });
  document.addEventListener("mousedown", (ev) => {
    if (menu && !menu.contains(ev.target)) removeMenu();
  });
  document.addEventListener("scroll", removeMenu, true);
  window.addEventListener("blur", removeMenu);
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (d && d.channel === "clipboard-result" && d.op === "paste") {
      insertText(String(d.text ?? ""));
    }
  });
}

// src/client/index.ts
var inject = ["slots", "locale", "connection", "remote", "theme"];
var THEME_DEFAULTED_KEY = "dsh-cline.theme-defaulted";
var MODELS_NAV_LABELS = /* @__PURE__ */ new Set(["\u6A21\u578B", "Models"]);
function apply(ctx) {
  installClipboard();
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@dsh-cline/host-services";
    tag.textContent = CLIENT_CSS;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "dsh-cline: stylesheet");
  ctx.effect(() => {
    try {
      if (localStorage.getItem(THEME_DEFAULTED_KEY) === null) {
        if (ctx.theme.getTheme().preference === "system") ctx.theme.setTheme("dark");
        localStorage.setItem(THEME_DEFAULTED_KEY, "1");
      }
    } catch (err) {
      ctx.logger.warn("dsh-cline client: dark-theme default skipped: " + String(err));
    }
    return void 0;
  }, "dsh-cline: first-run dark theme");
  ctx.effect(() => {
    const dedupeNav = () => {
      const buttons = document.querySelectorAll('[role="dialog"] nav button');
      let seen = false;
      for (const button of buttons) {
        if (!MODELS_NAV_LABELS.has((button.textContent ?? "").trim())) continue;
        const duplicate = seen;
        seen = true;
        const el = button;
        const display = duplicate ? "none" : "";
        if (el.style.display !== display) el.style.display = display;
      }
    };
    const observer = new MutationObserver(dedupeNav);
    observer.observe(document.body, { childList: true, subtree: true });
    dedupeNav();
    return () => {
      observer.disconnect();
    };
  }, "dsh-cline: settings nav dedupe");
  const connection = ctx.get("connection");
  if (connection === void 0) {
    ctx.logger.warn("dsh-cline client: connection service unavailable; surfaces dormant");
    return;
  }
  const api = connection.api;
  ctx.slots.inject("settings.onboarding", () => ctx.slots.register({
    name: "settings.onboarding",
    id: "deepseek-official",
    order: 0,
    priority: -1,
    inject: () => ({ api })
  }, SsyOnboarding));
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "models",
    order: 10,
    priority: -1,
    label: () => "\u6A21\u578B",
    inject: () => ({ api })
  }, DshClineModelsSection));
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "dsh-cline",
    order: 20,
    label: () => "DSH Cline",
    inject: () => ({ api })
  }, DshClineSection));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
