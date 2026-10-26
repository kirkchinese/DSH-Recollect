		// ---- Browser half: the plugin's settings page on the Plugins page. ----
		// Spliced into the module factory by client/build.mjs; PACKAGE, ROW_ID,
		// FIELDS and LOCALES are defined there.
		const React = require("react");
		const P = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;
		const NS = "recollectSettings." + ROW_ID;

		const CSS = ".ccm-root{display:grid;gap:4px;min-width:0;max-width:100%;overflow-wrap:anywhere}.ccm-root *{min-width:0}.ccm-label{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}.ccm-seg{max-width:100%;overflow-x:auto}.ccm-seg *{min-width:auto}.ccm-section,.ccm-row,.ccm-line{min-width:0;max-width:100%}.ccm-line>span{min-width:0}.ccm-big{font-size:15px;margin-top:16px}.ccm-sub{font-size:13px;font-weight:600;margin:10px 0 2px;color:var(--dsw-alias-label-primary)}.ccm-status-head{display:flex;gap:8px;align-items:center}.ccm-input{flex:1;min-width:0;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-separator, rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-family:var(--dsw-font-mono, monospace)}.ccm-kv{display:flex;gap:12px;font-size:13px;line-height:1.6}.ccm-k{color:var(--dsw-alias-label-tertiary);min-width:96px}.ccm-v{color:var(--dsw-alias-label-primary);word-break:break-all}.ccm-list{list-style:none;margin:0;padding:0;display:grid;gap:4px}.ccm-list li{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:1.5;flex-wrap:wrap}.ccm-path{color:var(--dsw-alias-label-primary);word-break:break-all}.ccm-desc{color:var(--dsw-alias-label-secondary, inherit);flex:1;min-width:200px}.ccm-meta{color:var(--dsw-alias-label-tertiary);margin-left:auto}.ccm-warn{font-size:12px;color:var(--dsw-alias-warning, #b26a00);margin:0}.ccm-chips{display:flex;flex-wrap:wrap;gap:6px}.ccm-chip{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--dsw-alias-separator, rgba(127,127,127,.3));background:none;color:var(--dsw-alias-label-secondary, inherit);cursor:pointer}.ccm-chip-on{border-color:var(--dsw-alias-link);color:var(--dsw-alias-link)}.ccm-section{display:grid;gap:12px;padding:4px 0 16px;border-bottom:1px solid var(--dsw-alias-separator, rgba(127,127,127,.18))}.ccm-section:last-of-type{border-bottom:none}.ccm-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:8px 0 0}.ccm-intro{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0}.ccm-row{display:grid;gap:4px}.ccm-line{display:flex;justify-content:space-between;align-items:center;gap:16px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}.ccm-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0}.ccm-reset{background:none;border:none;padding:0;font-size:12px;color:var(--dsw-alias-link);cursor:pointer}.ccm-reset:disabled{cursor:default;opacity:.5}.ccm-tag{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px}.ccm-note{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}";
		const injectCss = () => {
			if (typeof document === "undefined") return;
			const id = PACKAGE + "/settings.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(id) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = PACKAGE;
			tag.dataset.pluginCss = id;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		};

		/** Value at a dotted path, or undefined. */
		const at = (obj, path) => path.split(".").reduce((o, k) => (o !== null && typeof o === "object" ? o[k] : undefined), obj);
		/** Whether a dotted path is present in an object (an override marker). */
		const has = (obj, path) => {
			const keys = path.split(".");
			let o = obj;
			for (const k of keys) {
				if (o === null || typeof o !== "object" || !Object.prototype.hasOwnProperty.call(o, k)) return false;
				o = o[k];
			}
			return true;
		};
		const format = (field, value) => {
			if (field.kind === "list") return Array.isArray(value) ? value.join(", ") : "";
			if (field.kind === "number") return typeof value === "number" ? String(value) : "";
			if (field.kind === "text") return typeof value === "string" ? value : "";
			return value;
		};
		/** Parse a text draft: { set: value } | { clear: true } | undefined (invalid). */
		const parse = (field, text) => {
			const trimmed = String(text).trim();
			if (field.kind === "number") {
				if (trimmed === "") return { clear: true };
				const n = Number(trimmed);
				return Number.isFinite(n) ? { set: n } : undefined;
			}
			if (field.kind === "list") return trimmed === "" ? { set: [] } : { set: trimmed.split(",").map((s) => s.trim()).filter(Boolean) };
			return trimmed === "" ? { clear: true } : { set: trimmed };
		};

		/** The settings page. Drafts are local; one save writes every change in one mutation. */
		function SettingsPage(props) {
			const { t, view, form } = props;
			const [drafts, setDrafts] = React.useState(() => new Map());
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState(false);
			if (view === "summary") return t("summary");
			const snapshot = form?.state;
			const ready = snapshot?.status === "ready";
			const value = snapshot?.value ?? {};
			const user = snapshot?.user ?? {};
			const base = snapshot?.base ?? {};
			const writable = ready && snapshot.writable !== false;

			const fieldState = (field) => {
				const draft = drafts.get(field.path);
				if (draft === undefined) return { value: field.kind === "bool" || field.kind === "enum" ? at(value, field.path) : format(field, at(value, field.path)), overridden: has(user, field.path), invalid: false, dirty: false };
				if (draft.reset) return { value: field.kind === "bool" || field.kind === "enum" ? at(base, field.path) ?? at(value, field.path) : format(field, at(base, field.path)), overridden: false, invalid: false, dirty: true };
				if (field.kind === "bool" || field.kind === "enum") return { value: draft.value, overridden: true, invalid: false, dirty: true };
				const parsed = parse(field, draft.value);
				return { value: draft.value, overridden: parsed !== undefined && !parsed.clear, invalid: parsed === undefined, dirty: true };
			};
			const stage = (path, draft) => {
				setFailed(false);
				setDrafts((prev) => {
					const next = new Map(prev);
					next.set(path, draft);
					return next;
				});
			};
			const states = FIELDS.map((f) => [f, fieldState(f)]);
			const dirty = drafts.size > 0;
			const invalid = states.some(([, s]) => s.invalid);
			const shell = { available: ready, writable, dirty, invalid, saving, failed };

			const save = async () => {
				if (!form || !dirty || invalid || saving) return;
				const ops = [];
				for (const [f, s] of states) {
					const draft = drafts.get(f.path);
					if (draft === undefined) continue;
					const path = f.path.split(".");
					if (draft.reset) {
						if (has(user, f.path)) ops.push({ op: "unset", path });
						continue;
					}
					if (f.kind === "bool" || f.kind === "enum") {
						ops.push({ op: "set", path, value: draft.value });
						continue;
					}
					const parsed = parse(f, draft.value);
					if (parsed === undefined) continue;
					if (parsed.clear) {
						if (has(user, f.path)) ops.push({ op: "unset", path });
					} else ops.push({ op: "set", path, value: parsed.set });
					void s;
				}
				setSaving(true);
				try {
					const ok = ops.length === 0 || await form.mutate(ops, snapshot?.revision);
					if (ok) setDrafts(new Map());
					setFailed(!ok);
				} catch (_error) {
					setFailed(true);
				} finally {
					setSaving(false);
				}
			};
			const discard = () => {
				setDrafts(new Map());
				setFailed(false);
			};

			const disabled = !writable || saving;
			const resetLink = (f, s) => s.overridden ? h("button", { type: "button", className: "ccm-reset", disabled, onClick: () => stage(f.path, { reset: true }) }, t("reset")) : null;
			const renderField = ([f, s]) => {
				const id = "ccm-" + f.path.replace(/\./g, "-");
				const label = t("f." + f.path);
				const hint = t("h." + f.path);
				if (f.kind === "bool") return h("div", { className: "ccm-row", key: f.path },
					h("label", { className: "ccm-line" },
						h("span", null, label, s.overridden ? h("span", { className: "ccm-tag" }, t("overridden")) : null),
						h(P.Switch, { checked: s.value === true, label, disabled, onChange: (checked) => stage(f.path, { value: checked }) })),
					h("p", { className: "ccm-hint" }, hint, " ", resetLink(f, s)));
				if (f.kind === "enum") return h("div", { className: "ccm-row", key: f.path },
					h("span", { className: "ccm-label" }, label, s.overridden ? h("span", { className: "ccm-tag" }, t("overridden")) : null),
					h("div", { className: "ccm-seg" }, h(P.SegmentedControl, { id, label, disabled, value: s.value ?? f.options[0], options: f.options.map((o) => ({ value: o, label: t("o." + f.path + "." + o) })), onChange: (next) => stage(f.path, { value: next }) })),
					h("p", { className: "ccm-hint" }, hint, " ", resetLink(f, s)));
				return h(P.SettingsValueField, {
					key: f.path, id, label, hint,
					text: s.value, overridden: s.overridden, invalid: s.invalid,
					overriddenLabel: t("overridden"), resetLabel: t("reset"), invalidLabel: t("invalidNumber"),
					numeric: f.kind === "number", disabled,
					onEdit: (text) => stage(f.path, { value: text }),
					onReset: () => stage(f.path, { reset: true }),
				});
			};
			const sections = [];
			for (const f of FIELDS) if (!sections.includes(f.section)) sections.push(f.section);
			return h(P.SettingsForm, {
				labels: { unavailable: t("unavailable"), readOnly: t("readOnly"), saveFailed: t("saveFailed"), save: t("save"), saving: t("saving") },
				state: shell,
				onSave: () => { void save(); },
				onDiscard: discard,
				children: [
					h("p", { className: "ccm-note", key: "__note" }, t("restartNote")),
					...sections.map((section) => h("section", { className: "ccm-section", key: section },
						h("h3", { className: "ccm-title" }, t("s." + section)),
						h("p", { className: "ccm-intro" }, t("d." + section)),
						...states.filter(([f]) => f.section === section).map(renderField))),
				],
			});
		}

		// ---- Remote status (read-only) ----
		const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
		const STATUS = {
			id: PACKAGE + "#" + SERVICE + "/status",
			service: SERVICE,
			namespace: SERVICE,
			method: "status",
			invocation: { kind: "direct" },
			parameters: [{ name: "request", wire: "request", source: "json", codec: { mode: "strict", typeSymbol: PACKAGE + "#StatusRequest", create: () => ({ parse: (v) => (isObj(v) ? v : {}) }) } }],
			cancellation: { parameter: "signal" },
			result: { mode: "strict", typeSymbol: PACKAGE + "#StatusResponse", create: () => ({ parse: (v) => { if (!isObj(v) || !Array.isArray(v.files)) throw new TypeError("invalid status"); return v; } }) },
			sourceLocation: { file: "index.js", line: 1, column: 1 },
		};

		const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch (_e) { return iso; } };

		/** Loaded instruction and memory files for one working directory. */
		function StatusPanel(props) {
			const { t, status } = props;
			const [cwd, setCwd] = React.useState("");
			const [data, setData] = React.useState(undefined);
			const [state, setState] = React.useState("loading");
			const load = React.useCallback(async (dir) => {
				setState("loading");
				try {
					const res = await status(dir ? { cwd: dir } : {});
					if (res && res.ok === false) throw new Error(String(res.error?.message ?? "failed"));
					const value = res && "value" in res ? res.value : res;
					setData(value);
					setCwd(value.cwd);
					setState("ready");
				} catch (_e) {
					setState("failed");
				}
			}, [status]);
			React.useEffect(() => { void load(""); }, [load]);
			const head = h("div", { className: "ccm-status-head" },
				h("input", { className: "ccm-input", value: cwd, placeholder: t("status.cwdPlaceholder"), onChange: (e) => setCwd(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") void load(cwd); } }),
				h(P.Button, { variant: "outline", size: "sm", onClick: () => void load(cwd) }, t("status.refresh")));
			if (state === "loading" && data === undefined) return h("section", { className: "ccm-section" }, h("h3", { className: "ccm-title" }, t("status.title")), head, h("p", { className: "ccm-hint" }, t("status.loading")));
			if (state === "failed") return h("section", { className: "ccm-section" }, h("h3", { className: "ccm-title" }, t("status.title")), head, h("p", { className: "ccm-hint" }, t("status.failed")));
			const d = data;
			const kv = (k, v) => h("div", { className: "ccm-kv" }, h("span", { className: "ccm-k" }, k), h("span", { className: "ccm-v" }, v));
			return h("section", { className: "ccm-section" },
				h("h3", { className: "ccm-title" }, t("status.title")),
				h("p", { className: "ccm-intro" }, t("status.intro")),
				head,
				d.dirs && d.dirs.length > 1 ? h("div", { className: "ccm-chips" }, d.dirs.map((dir) => h("button", { type: "button", key: dir, className: "ccm-chip" + (dir === d.cwd ? " ccm-chip-on" : ""), onClick: () => void load(dir) }, dir))) : null,
				kv(t("status.memory"), t("status.memory." + d.memory)),
				kv(t("status.mode"), t("o.memory.writeMode." + (d.mode === "readonly" ? "readonly" : d.mode))),
				kv(t("status.memoryDir"), h("code", null, d.memoryDir)),
				h("h4", { className: "ccm-sub" }, t("status.files") + " · " + d.files.length + " · " + d.total.toLocaleString() + " " + t("status.chars")),
				d.warn ? h("p", { className: "ccm-warn" }, t("status.warn").replace("{n}", String(d.warn))) : null,
				d.files.length === 0 ? h("p", { className: "ccm-hint" }, t("status.noFiles")) :
					h("ul", { className: "ccm-list" }, d.files.map((f, i) => h("li", { key: i },
						h(P.Tag, { tone: f.type === "AutoMem" ? "info" : f.type === "Managed" ? "warning" : "quiet" }, f.type),
						h("code", { className: "ccm-path" }, f.path),
						h("span", { className: "ccm-meta" }, f.chars.toLocaleString() + " " + t("status.chars"))))),
				h("h4", { className: "ccm-sub" }, t("status.memories") + " · " + d.memories.length),
				d.memories.length === 0 ? h("p", { className: "ccm-hint" }, t("status.noMemories")) :
					h("ul", { className: "ccm-list" }, d.memories.map((m) => h("li", { key: m.path },
						m.type ? h(P.Tag, { tone: "quiet" }, m.type) : null,
						h("code", { className: "ccm-path" }, m.path),
						h("span", { className: "ccm-desc" }, m.description),
						h("span", { className: "ccm-meta" }, fmtTime(m.updatedAt))))));
		}

		/** Settings dialog section: status panel plus the settings form. */
		function SettingsSection(props) {
			const { t, configForm } = props;
			const snapshot = React.useSyncExternalStore(configForm.subscribe.bind(configForm), configForm.getSnapshot.bind(configForm));
			const form = { state: snapshot, mutate: (ops, rev) => configForm.mutate(ops, rev) };
			return h("div", { className: "ccm-root" },
				props.status ? h(StatusPanel, { t, status: props.status }) : null,
				h("h3", { className: "ccm-title ccm-big" }, t("settingsTitle")),
				h(SettingsPage, { t, view: "page", form }));
		}

		const inject = ["slots", "locale", "remote", "configForms"];
		async function apply(ctx) {
			injectCss();
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, LOCALES), PACKAGE + ": dictionaries");
			ctx.effect(() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: PACKAGE + "#" + ROW_ID,
				locale: NS,
			}, SettingsPage)), PACKAGE + ": plugin page");
			const configForm = ctx.configForms.get(ROW_ID);
			const registerSection = (status) => ctx.slots.register({
				name: "settings.section",
				id: ROW_ID,
				order: 46,
				label: () => t("sectionLabel"),
				locale: NS,
				inject: () => ({ configForm, status }),
			}, SettingsSection);
			let unmount;
			try {
				unmount = await ctx.remote.$mount({ package: PACKAGE, descriptors: [STATUS] });
			} catch (_error) {
				unmount = undefined;
			}
			if (unmount) ctx.effect(() => () => { void unmount(); }, PACKAGE + ": remote");
			if (unmount) {
				ctx.inject(["remote." + SERVICE], (rctx) => {
					rctx.effect(() => rctx.slots.inject("settings.section", () => registerSection((req) => rctx.remote[SERVICE].status(req))), PACKAGE + ": settings section");
				});
			} else {
				ctx.effect(() => ctx.slots.inject("settings.section", () => registerSection(undefined)), PACKAGE + ": settings section");
			}
		}
		exports.inject = inject;
		exports.apply = apply;
