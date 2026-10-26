		// ---- Browser half: the plugin's settings page on the Plugins page. ----
		// Spliced into the module factory by client/build.mjs; PACKAGE, ROW_ID,
		// FIELDS and LOCALES are defined there.
		const React = require("react");
		const P = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;
		const NS = "recollectSettings." + ROW_ID;

		const CSS = ".ccm-section{display:grid;gap:12px;padding:4px 0 16px;border-bottom:1px solid var(--dsw-alias-separator, rgba(127,127,127,.18))}.ccm-section:last-of-type{border-bottom:none}.ccm-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:8px 0 0}.ccm-intro{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0}.ccm-row{display:grid;gap:4px}.ccm-line{display:flex;justify-content:space-between;align-items:center;gap:16px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}.ccm-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0}.ccm-reset{background:none;border:none;padding:0;font-size:12px;color:var(--dsw-alias-link);cursor:pointer}.ccm-reset:disabled{cursor:default;opacity:.5}.ccm-tag{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px}.ccm-note{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}";
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
					h("div", { className: "ccm-line" },
						h("span", null, label, s.overridden ? h("span", { className: "ccm-tag" }, t("overridden")) : null),
						h(P.SegmentedControl, { id, label, disabled, value: s.value ?? f.options[0], options: f.options.map((o) => ({ value: o, label: t("o." + f.path + "." + o) })), onChange: (next) => stage(f.path, { value: next }) })),
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

		const inject = ["slots", "locale"];
		function apply(ctx) {
			injectCss();
			ctx.effect(() => ctx.locale.register(NS, LOCALES), PACKAGE + ": dictionaries");
			ctx.effect(() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: PACKAGE + "#" + ROW_ID,
				locale: NS,
			}, SettingsPage)), PACKAGE + ": settings page");
		}
		exports.inject = inject;
		exports.apply = apply;
