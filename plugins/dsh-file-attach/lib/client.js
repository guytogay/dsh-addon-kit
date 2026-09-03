window.__ModuleLoader__.load({
	id: "dsh-file-attach",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { createElement: h, useState, useEffect, useRef, useCallback } = react;

		// ──── constants ────

		const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
		const CHUNK_BYTES = 4 * 1024 * 1024;

		const KIND_LABEL = {
			audio: ["音频", "audio"],
			video: ["视频", "video"],
			office: ["Office 文档", "Office document"],
			pdf: ["PDF", "PDF"],
			text: ["文本", "text"],
			image: ["图片", "image"],
			file: ["文件", "file"],
		};

		const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

		/** Detect the real raster format from magic bytes, or null. */
		async function detectImageType(file) {
			try {
				const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
				if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return "image/jpeg";
				if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) return "image/png";
				if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return "image/gif";
				if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
					head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return "image/webp";
			} catch { /* fall through */ }
			return null;
		}

		function isZh(id) {
			return id === "zh" || id === "zh-CN" || id === "zh-TW" || id === "zh-Hans" || id === "zh-Hant";
		}

		function humanSize(bytes) {
			const n = Number(bytes) || 0;
			if (n < 1024) return n + " B";
			if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
			if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
			return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
		}

		const kindOf = (kind) => (KIND_LABEL[kind] || ["文件", "file"]);

		function chipIcon(kind, name) {
			const ext = extensionOf(name);
			if (kind === "audio") return "🎵";
			if (kind === "video") return "🎬";
			if (kind === "pdf") return "📄";
			if (kind === "office") return "📊";
			if (kind === "text") return "📝";
			if (kind === "image") return "🖼️";
			return "📁";
		}

		function extensionOf(name) {
			const dot = String(name || "").lastIndexOf(".");
			return dot === -1 ? "" : String(name).slice(dot + 1).toLowerCase();
		}

		/** Reference line whose WHOLE token (`@emoji+name+size`) renders as one
		 *  official chip in the bubble — same block look as the composer chip.
		 *  The size keeps no spaces so the token never splits mid-chip. */
		function buildBlock(value, _zh) {
			return `@${chipIcon(value.kind, value.name)}${value.name}·${humanSize(value.size).replace(/\s+/gu, "")}`;
		}

		// ──── paperclip icon (feather style, stroke) ────

		const PAPERCLIP_PATH = "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48";

		function PaperclipIcon({ size = 16 }) {
			return h("svg", {
				viewBox: "0 0 24 24",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				"stroke-width": 2,
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
				style: { flex: "none", display: "block" },
			}, h("path", { d: PAPERCLIP_PATH }));
		}

		// ──── wire descriptors ────

		const jsonCodec = {
			mode: "strict",
			typeSymbol: "dsh-file-attach/json",
			schema: { parse: (value) => value },
		};

		function params(...names) {
			return names.map((name) => ({ name, wire: name, source: "json", codec: jsonCodec }));
		}

		function desc(method, parameterNames) {
			return {
				id: `dsh-file-attach#attachUpload/${method}`,
				service: "attachUpload",
				namespace: "attachUpload",
				method,
				invocation: { kind: "direct" },
				parameters: params(...parameterNames),
				result: jsonCodec,
			};
		}

		const descriptors = [
			desc("beginUpload", ["sessionId", "name", "size"]),
			desc("uploadChunk", ["uploadId", "index", "data"]),
			desc("finishUpload", ["uploadId"]),
			desc("abortUpload", ["uploadId"]),
		];

		// ──── upload plumbing ────

		function blobToBase64(blob) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const url = String(reader.result || "");
					resolve(url.slice(url.indexOf(",") + 1));
				};
				reader.onerror = () => reject(new Error("读取文件失败"));
				reader.readAsDataURL(blob);
			});
		}

		function resultOf(res) {
			if (res && res.ok === true) return { ok: true, value: res.value };
			return { ok: false, message: (res && res.error && res.error.message) || "上传出错" };
		}

		async function uploadFile(api, sessionId, file, onProgress) {
			const begin = resultOf(await api.beginUpload(sessionId, file.name, file.size));
			if (!begin.ok) throw new Error(begin.message);
			const uploadId = begin.value.uploadId;
			try {
				const total = Math.ceil(file.size / CHUNK_BYTES);
				for (let index = 0; index < total; index++) {
					const slice = file.slice(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, file.size));
					const b64 = await blobToBase64(slice);
					const chunk = resultOf(await api.uploadChunk(uploadId, index, b64));
					if (!chunk.ok) throw new Error(chunk.message);
					if (onProgress) onProgress(Math.round(Math.min(1, ((index + 1) * CHUNK_BYTES) / file.size) * 100));
				}
				const finish = resultOf(await api.finishUpload(uploadId));
				if (!finish.ok) throw new Error(finish.message);
				return finish.value;
			} catch (err) {
				try { await api.abortUpload(uploadId); } catch { /* best effort */ }
				throw err;
			}
		}

		// ──── composer helpers ────

		/** The composer textarea, by stable class. */
		function composerTa() {
			return document.querySelector("textarea.uV2eYG_input")
				|| document.querySelector("textarea[placeholder]:not([readonly])");
		}

		/** The scroll container holding the grow box (textarea anchor) — the
		 *  document-flow slot where the chips row belongs: textarea descends. */
		function composerSlot() {
			const ta = composerTa();
			const grow = ta ? ta.parentElement : null;
			const scroll = grow ? grow.parentElement : null;
			return scroll;
		}

		function shortName(name) {
			const chars = Array.from(String(name || ""));
			let width = 0;
			const kept = [];
			for (const ch of chars) {
				const w = ch.codePointAt(0) > 0xFF ? 2 : 1;
				if (width + w > 14) break;
				width += w;
				kept.push(ch);
			}
			return kept.length < chars.length ? kept.join("") + "…" : chars.join("");
		}

		/** Build a chip DOM node (plain DOM: no React ownership conflicts). */
		function buildChipDom(it, zh, onRemove) {
			const span = document.createElement("span");
			span.className = "dsh-fa-chip";
			span.title = it.status === "error" ? (it.error || "error") : (it.path || it.name);
			span.style.cssText = [
				"display:inline-flex", "align-items:center", "gap:6px",
				"max-width:240px", "padding:4px 8px", "border-radius:8px",
				"background:var(--dsw-alias-fill-3, rgba(255,255,255,0.07))",
				"color:var(--dsw-alias-label-secondary)", "font-size:12px",
				"line-height:1.2", "white-space:nowrap", "overflow:hidden",
				"flex:none",
			].join(";");
			const label = document.createElement("span");
			label.style.cssText = "overflow:hidden;text-overflow:ellipsis;max-width:200px;display:inline-flex;align-items:center;gap:4px;";
			const glyph = document.createElement("span");
			glyph.textContent = it.status === "error" ? "❌"
				: it.status === "uploading" ? "⏳" : chipIcon(it.kind, it.name);
			const nameEl = document.createElement("span");
			nameEl.textContent = it.status === "uploading"
				? shortName(it.name) + " " + (it.progress || 0) + "%"
				: shortName(it.name) + " · " + humanSize(it.size);
			label.append(glyph, nameEl);
			const btn = document.createElement("button");
			btn.type = "button";
			btn.setAttribute("aria-label", zh ? "移除附件" : "Remove attachment");
			btn.title = zh ? "移除附件" : "Remove attachment";
			btn.textContent = "×";
			btn.style.cssText = "border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0 2px;font-size:14px;line-height:1;flex:none;";
			btn.addEventListener("click", () => onRemove(it.uid));
			span.append(label, btn);
			return span;
		}

		// ──── composer attachment button ────

		const btnStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: "34px",
			height: "34px",
			border: "none",
			borderRadius: "10px",
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			cursor: "pointer",
			padding: "6px",
			WebkitTapHighlightColor: "transparent",
			flex: "none",
		};

		function AttachFiles(props) {
			const { sessionId, api, locale, conversation, inputActions } = props;
			const [items, setItems] = useState([]);
			const itemsRef = useRef([]);
			useEffect(() => { itemsRef.current = items; }, [items]);
			const fileRef = useRef(null);
			const mountedRef = useRef(true);
			const chipsHostRef = useRef(null);
			const [zh, setZh] = useState(() => {
				const snap = locale && locale.getLocale ? locale.getLocale() : undefined;
				return snap && snap.active ? isZh(String(snap.active)) : true;
			});

			useEffect(() => {
				mountedRef.current = true;
				return () => { mountedRef.current = false; if (fileRef.current) fileRef.current.value = ""; };
			}, []);

			useEffect(() => {
				if (locale && locale.subscribe) {
					return locale.subscribe(() => {
						const snap = locale.getLocale ? locale.getLocale() : undefined;
						setZh(snap && snap.active ? isZh(String(snap.active)) : true);
					});
				}
				return undefined;
			}, [locale]);

			const updateItem = useCallback((uid, patch) => {
				if (!mountedRef.current) return;
				setItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, ...patch } : it)));
			}, []);

			const removeItem = useCallback((uid) => {
				setItems((prev) => prev.filter((it) => it.uid !== uid));
			}, []);

			/** Append the reference line to the composer textarea (React controlled). */
			const carryRefLine = useCallback((value) => {
				const ta = composerTa();
				if (!ta || typeof ta.value !== "string") return;
				const line = buildBlock(value, zh);
				const cur = ta.value || "";
				ta.value = cur + (cur ? "\n" : "") + line;
				ta.dispatchEvent(new Event("input", { bubbles: true }));
			}, [zh]);

			/** Auto-carry AT SEND TIME through the official input machine:
			 *  `inputActions.setDraft` updates the machine synchronously, so the
			 *  official submit path always sees the reference lines. The input
			 *  stays clean while typing. Ready files are then cleared from the
			 *  chip row (they travelled with the message). */
			const ensureCarriedBeforeSend = useCallback(() => {
				const ta = composerTa();
				if (!ta) return;
				const ready = itemsRef.current.filter((it) => it.status === "ready" && it.path);
				if (ready.length === 0) return;
				const cur = ta.value || "";
				const missing = [];
				for (const it of ready) {
					const line = buildBlock({ name: it.name, path: it.path, kind: it.kind || "file", size: it.size, preview: it.preview }, zh);
					const head = line.slice(0, 30);
					if (!cur.includes(head) && !missing.some((m) => m.includes(head))) missing.push(line);
				}
				if (missing.length > 0) {
					const next = cur + (cur ? "\n" : "") + missing.join("\n");
					if (inputActions && typeof inputActions.setDraft === "function") {
						inputActions.setDraft(next);
					} else {
						// fallback: direct DOM write (React controlled)
						ta.value = next;
						ta.dispatchEvent(new Event("input", { bubbles: true }));
					}
				}
				// The ready files now ride with this send; drop their chips.
				setItems((prev) => prev.filter((it) => !(it.status === "ready" && it.path)));
			}, [zh, inputActions]);

			// Capture-phase send interception: Enter in the composer or a tap on
			// the send button appends the reference lines just before the send.
			useEffect(() => {
				const onKey = (e) => {
					if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
					const ta = composerTa();
					if (!ta) return;
					if (e.target === ta || (ta.contains && ta.contains(e.target))) ensureCarriedBeforeSend();
				};
				const onClick = (e) => {
					const btn = e.target && e.target.closest ? e.target.closest("button") : null;
					if (!btn) return;
					const label = ((btn.getAttribute("aria-label") || "") + " " + (btn.title || "")).toLowerCase();
					if (label.indexOf("发送") !== -1 || label.indexOf("send") !== -1) ensureCarriedBeforeSend();
				};
				document.addEventListener("keydown", onKey, true);
				document.addEventListener("click", onClick, true);
				return () => {
					document.removeEventListener("keydown", onKey, true);
					document.removeEventListener("click", onClick, true);
				};
			}, [ensureCarriedBeforeSend]);

			// Plain-DOM chips host: inserted in document flow above the textarea
			// anchor inside the composer scroll container; textarea moves down.
			useEffect(() => {
				if (items.length === 0) {
					// Remove the host entirely when nothing is left (fixes the
					// "last chip cannot be removed" bug).
					if (chipsHostRef.current !== null) {
						const host = chipsHostRef.current;
						if (host.parentElement !== null) host.parentElement.removeChild(host);
						chipsHostRef.current = null;
					}
					return;
				}
				const scroll = composerSlot();
				if (scroll === null || typeof scroll.insertBefore !== "function") return;
				if (chipsHostRef.current === null) {
					const host = document.createElement("div");
					host.className = "dsh-fa-chips";
					host.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px 0;align-items:center;";
					chipsHostRef.current = host;
					const grow = composerTa() ? composerTa().parentElement : null;
					if (grow !== null) scroll.insertBefore(host, grow);
					else scroll.appendChild(host);
				}
				const host = chipsHostRef.current;
				if (host.parentElement !== scroll) {
					const grow = composerTa() ? composerTa().parentElement : null;
					if (grow !== null) scroll.insertBefore(host, grow);
					else scroll.appendChild(host);
				}
				host.replaceChildren(...items.map((it) => buildChipDom(it, zh, removeItem)));
			}, [items, zh, removeItem]);

			const onFiles = useCallback(async (event) => {
				const files = Array.from(event.target.files || []);
				if (event.target) event.target.value = "";
				if (!api) return;
				for (const file of files) {
					const uid = (typeof crypto !== "undefined" && crypto.randomUUID)
						? crypto.randomUUID()
						: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
					const size = file.size || 0;

					// Images join the built-in draft-image pipeline: they become
					// real image parts in the message (the model sees them directly,
					// like pasted/browser-sent images) — no server upload, no
					// reference line, no file chip. The official rail shows the
					// thumbnail with its own remove control.
					const detectedMime = await detectImageType(file);
					if (detectedMime !== null) {
						if (!conversation || !inputActions || !inputActions.addImages) {
							setItems((prev) => [...prev, {
								uid, name: file.name, size, status: "error",
								error: zh ? "图片附件暂不可用" : "image attachment unavailable",
							}]);
							continue;
						}
						try {
							const normalized = file.type === detectedMime
								? file
								: new File([file], file.name, { type: detectedMime });
							const images = conversation.createDraftImages([normalized]);
							if (!inputActions.addImages(images.map((img) => img.id))) {
								for (const img of images) conversation.releaseDraftImage(img.id);
								setItems((prev) => [...prev, {
									uid, name: file.name, size, status: "error",
									error: zh ? "输入正忙，请稍后再添加图片" : "input busy — try adding the image again",
								}]);
							}
						} catch (err) {
							setItems((prev) => [...prev, {
								uid, name: file.name, size, status: "error",
								error: String((err && err.message) || err),
							}]);
						}
						continue;
					}

					if (size > MAX_UPLOAD_BYTES) {
						setItems((prev) => [...prev, { uid, name: file.name, size, status: "error", error: zh ? "文件超过 1GB 上限" : "file exceeds the 1GB limit" }]);
						continue;
					}
					setItems((prev) => [...prev, { uid, name: file.name, size, status: "uploading", progress: 0, kind: "file" }]);
					uploadFile(api, sessionId, file, (progress) => updateItem(uid, { progress }))
						.then((value) => {
							updateItem(uid, {
								status: "ready",
								progress: 100,
								path: value.path,
								kind: value.kind,
								size: value.size,
								preview: typeof value.preview === "string" && value.preview.length > 0 ? value.preview : null,
							});
						})
						.catch((err) => {
							updateItem(uid, { status: "error", error: String((err && err.message) || err) });
						});
				}
			}, [api, sessionId, zh, updateItem, carryRefLine, conversation, inputActions]);

			if (!api) return h("span", { className: "dsh-fa-wrap" });

			const tooltip = zh ? "上传文件" : "Attach files";

			return h("span", { className: "dsh-fa-wrap", style: { display: "inline-flex", alignItems: "center", flex: "none" } },
				h("button", {
					type: "button",
					className: "dsh-fa-btn",
					"aria-label": tooltip,
					title: tooltip,
					style: btnStyle,
					onClick: () => { if (fileRef.current) fileRef.current.click(); },
				}, h(PaperclipIcon, { size: 16 })),
				h("input", {
					ref: fileRef,
					type: "file",
					multiple: true,
					accept: "*/*",
					style: { display: "none" },
					onChange: onFiles,
				}),
			);
		}

		// ──── plugin entry ────

		const inject = ["slots", "remote", "locale"];

		async function apply(ctx) {
			const disposeMount = await ctx.remote.$mount({
				package: "dsh-file-attach",
				descriptors,
			});
			const api = ctx.get("remote.attachUpload");
			const conversation = ctx.get("conversation");

			ctx.inject(["slots", "locale"], (scope) => {
				const slots = scope.slots;
				slots.inject("conversation.input.left", () => slots.register(
					{
						name: "conversation.input.left",
						id: "file-attach",
						order: 0,
						inject: () => ({ api, locale: scope.locale, conversation }),
					},
					AttachFiles,
				));
			});

			return async () => {
				await disposeMount();
			};
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
