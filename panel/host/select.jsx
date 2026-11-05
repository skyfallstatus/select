// Select ExtendScript host. ES3 only: no JSON, no Array.indexOf, no reserved words as names.
// The panel calls one function, slCall(fn, jsonArgs), which always returns a JSON string in pure ASCII, with `ms`, the
// time the call took inside Premiere.
// A write comes in batches of about 100 items. Every call checks playback, dialogs and the project itself, and names
// each item by its id and its media path: an item whose path no longer matches is left alone and reported.
// Subclips are never written to: they share their master clip's media path, and Select acts on the master.
// Nothing here renames a clip or touches a file on disk. The only sequences it touches are the ones Make Sequence made,
// and only to remove one again, by its id.

var SELECT_HOST_VERSION = '0.2.0';
// The shape of the calls. The panel loads this file again when an older one is still in Premiere's script engine.
var SELECT_HOST_PROTOCOL = 3;
var SELECT_NS = 'http://ns.adobe.com/premierePrivateProjectMetaData/1.0/';
// Up to this many paths, Premiere's own search runs once per path: about 2 ms each, and it hands out only the items
// found. Past it, one search for every media item: quicker at first, but it hands out every clip in the project, which
// slows every later call (see "finding items" below). Measured on 26.5.2.
var SL_FEW_PATHS = 100;

// ---------------------------------------------------------------- JSON out (ASCII only)

function slEscape(c) {
    if (c === '"') { return '\\"'; }
    if (c === '\\') { return '\\\\'; }
    var h = c.charCodeAt(0).toString(16);
    return '\\u' + '0000'.substring(h.length) + h;
}

// One replace instead of a loop per character: ExtendScript is slow at string building, and many paths are accented.
function slQuote(s) {
    s = String(s);
    if (/^[\x20\x21\x23-\x5b\x5d-\x7e]*$/.test(s)) { return '"' + s + '"'; }
    return '"' + s.replace(/[\x00-\x1f"\\\x7f-\uffff]/g, slEscape) + '"';
}

function slJson(v) {
    if (v === null || v === undefined) { return 'null'; }
    var t = typeof v, parts, i, k;
    if (t === 'number') { return isFinite(v) ? String(v) : 'null'; }
    if (t === 'boolean') { return v ? 'true' : 'false'; }
    if (t === 'string') { return slQuote(v); }
    parts = [];
    if (v instanceof Array) {
        for (i = 0; i < v.length; i++) { parts.push(slJson(v[i])); }
        return '[' + parts.join(',') + ']';
    }
    for (k in v) {
        if (v.hasOwnProperty(k)) { parts.push(slQuote(k) + ':' + slJson(v[k])); }
    }
    return '{' + parts.join(',') + '}';
}

function slFail(code, message, extra) {
    var o = { ok: false, code: code, message: message }, k;
    if (extra) { for (k in extra) { if (extra.hasOwnProperty(k)) { o[k] = extra[k]; } } }
    return o;
}

function slNow() { return new Date().getTime(); }

// ---------------------------------------------------------------- project, playback, undo

function slProjectPath() {
    try {
        if (app.project && app.project.path) { return String(app.project.path); }
    } catch (e) {}
    return null;
}

function slProjectName() {
    try { return String(app.project.name); } catch (e) { return null; }
}

// Premiere's id for the project. A copy of a .prproj keeps its original's id, so the path and the id together name a
// project, never the id alone.
function slProjectId() {
    try { return String(app.project.documentID); } catch (e) { return null; }
}

function slProjectInfo() {
    var path = slProjectPath();
    return path ? { path: path, name: slProjectName(), id: slProjectId() } : null;
}

// Any state that is not a proven false is unknown.
function slPlayback() {
    var st = { program: null, source: null, modal: null, error: null };
    try { app.enableQE(); } catch (e) { st.error = String(e); return st; }
    try {
        if (typeof qe.getModalWindowID === 'function') { st.modal = String(qe.getModalWindowID() || ''); }
    } catch (e1) { st.modal = null; }
    var active = null;
    try { active = app.project ? app.project.activeSequence : null; } catch (e2) {}
    try {
        var q = qe.project.getActiveSequence();
        if (q) {
            var v = q.player.isPlaying;
            st.program = (v === true || v === false) ? v : null;
        } else {
            st.program = active ? null : false;
        }
    } catch (e3) { st.program = null; }
    try {
        var w = (qe.source && qe.source.player) ? qe.source.player.isPlaying : false;
        st.source = (w === true || w === false) ? w : null;
    } catch (e4) { st.source = null; }
    return st;
}

// A project's name from its path, without the folders or .prproj.
function slTitle(path) {
    var p = String(path);
    return p.substring(p.lastIndexOf('/') + 1).replace(/\.prproj$/i, '');
}

function slWrongProject(path, expectProject) {
    var now = slTitle(path), want = slTitle(expectProject);
    return slFail('wrong-project', now === want ? 'The project in front is another ' + want + ', in a different folder.' : 'The project in front is ' + now + ', not ' + want + '.', { active: path });
}

// Refusals are said in a few words (the panel's own, CONTRACTS 5.8); the codes say the rest.
var SL_NO_ANSWER = 'Premiere didn\'t answer. Nothing was written.';

// null when a write may run, else the refusal to return. Unknown is refused. playing: a call that changes nothing in
// the project, such as a selection, may run while Premiere plays.
function slGuard(expectProject, playing) {
    var path = slProjectPath();
    if (!path) { return slFail('no-project', 'No project is open.'); }
    if (expectProject && path !== expectProject) { return slWrongProject(path, expectProject); }
    var st = slPlayback();
    if (st.modal) { return slFail('modal', 'A Premiere dialog is open.', { playback: st }); }
    if (st.modal === null) { return slFail('modal-unknown', SL_NO_ANSWER, { playback: st }); }
    if (playing) { return null; }
    if (st.program === true || st.source === true) {
        return slFail('playing', 'Playback is running.', { playback: st });
    }
    if (st.program !== false || st.source !== false) {
        return slFail('playback-unknown', SL_NO_ANSWER, { playback: st });
    }
    return null;
}

// ---------------------------------------------------------------- finding items

// Every project item Premiere hands to a script stays in its script engine until Premiere quits, even after the script
// has let it go, and every one makes each later item slower to hand out, to every panel: one item per call per item
// touched, so a walk of a 1,200-item project adds 1,200 (measured on 26.5.2: about 3 ms per item once 120,000 had piled
// up, against well under 0.1 ms at the start). So the host asks for as few as it can: Premiere's own search by media
// path rather than a walk of every bin, one index per write rather than one per batch, and no selection event (below).

function slMediaPath(it) {
    try { return String(it.getMediaPath() || ''); } catch (e) { return ''; }
}

// Media items under `under`, subclips left out, in the Project panel's order. Premiere matches any part of the path, so
// '/' is every item with media and a path is that path and any longer one.
function slSearch(under, text) {
    var found = null;
    try { found = under.findItemsMatchingMediaPath(text, true); } catch (e) {}
    return found || [];
}

// [{item, path}] for every media path in `paths` exactly, once per item, each form of a path tried.
function slFindPaths(paths) {
    var want = {}, out = [], seen = {}, n = 0, i, j, list, it, p, root = app.project.rootItem;
    for (i = 0; i < paths.length; i++) {
        if (!want['p' + paths[i]]) { want['p' + paths[i]] = true; n++; }
    }
    var add = function (it2, p2) {
        var k = 'n' + it2.nodeId;
        if (!seen[k]) { seen[k] = true; out.push({ item: it2, path: p2 }); }
    };
    if (n <= SL_FEW_PATHS) {
        for (i = 0; i < paths.length; i++) {
            list = slSearch(root, paths[i]);
            for (j = 0; j < list.length; j++) {
                p = slMediaPath(list[j]);
                if (p === String(paths[i])) { add(list[j], p); }
            }
        }
    } else {
        list = slSearch(root, '/');
        for (j = 0; j < list.length; j++) {
            it = list[j];
            p = slMediaPath(it);
            if (p && want['p' + p] === true) { add(it, p); }
        }
    }
    return out;
}

function slWalk(item, fn) {
    var kids = item.children, n = kids ? kids.numItems : 0, i, c;
    for (i = 0; i < n; i++) {
        c = kids[i];
        if (c.type === 2) { slWalk(c, fn); } else { fn(c); }
    }
}

function slIndexInto(bin, index) {
    var kids = bin.children, n = kids ? kids.numItems : 0, i, c, id;
    for (i = 0; i < n; i++) {
        c = kids[i];
        id = 'n' + c.nodeId;
        if (c.type === 2) {
            index.bins[id] = c;
            slIndexInto(c, index);
        } else {
            index.items[id] = c;
            index.parents[id] = bin;
        }
    }
}

// Ids are the only way the panel names a clip to a write.
function slIndex() {
    var index = { items: {}, parents: {}, bins: {} }, root = app.project.rootItem;
    index.bins['n' + root.nodeId] = root;
    slIndexInto(root, index);
    return index;
}

// One index per write: the first batch builds it, the next ones of the same write (a.write, the panel's id for it)
// reuse it, and the last batch lets it go. Bins made on the way are added to it. Each item is still checked against its
// path, so an item deleted or changed meanwhile is left alone. Loading this file again keeps it.
var slCache;
if (slCache === undefined) { slCache = null; }

function slIndexFor(a) {
    var path = slProjectPath(), token = a && a.write ? String(a.write) : null, t0 = slNow();
    if (token && slCache && slCache.token === token && slCache.path === path && t0 - slCache.at < 600000) {
        slCache.used++;
        return slCache;
    }
    var c = { token: token, path: path, at: t0, used: 0, index: slIndex() };
    c.ms = slNow() - t0;
    if (token) { slCache = c; }
    return c;
}

function slLetGo(a) {
    if (!a || !a.write || (slCache && slCache.token === String(a.write))) { slCache = null; }
}

// A bin at the top of the project, by its id: a few items to look through, not the whole project.
function slTopBin(id) {
    var kids = app.project.rootItem.children, i;
    for (i = 0; i < kids.numItems; i++) {
        if (kids[i].type === 2 && String(kids[i].nodeId) === String(id)) { return kids[i]; }
    }
    return null;
}

// treePath is \Project.prproj\Bin\Sub\Clip: the bins between, as Bin/Sub, '' at the top. Cheap: no walk.
function slBinPath(it) {
    var t = '';
    try { t = String(it.treePath); } catch (e) { return null; }
    var parts = t.split('\\'), out = [], i;
    for (i = 2; i < parts.length - 1; i++) { out.push(parts[i]); }
    return out.join('/');
}

function slLastPart(binPath) {
    return binPath ? binPath.substring(binPath.lastIndexOf('/') + 1) : '';
}

function slRecord(it, path) {
    return { id: String(it.nodeId), path: path, name: String(it.name), bin: slBinPath(it) };
}

// {items} for the selection the editor means, {several: n} when more than one Project panel has one and none is
// current, or null when nothing is selected.
function slSelection() {
    var sel = null, views, i, found = [];
    try { sel = app.getCurrentProjectViewSelection(); } catch (e) {}
    if (sel && sel.length) { return { items: sel }; }
    // Focus is on this panel, so the "current" view can be empty while a Project panel still has a selection.
    var path = slProjectPath();
    try {
        views = app.getProjectViewIDs();
        for (i = 0; views && i < views.length; i++) {
            var p = app.getProjectFromViewID(views[i]);
            if (p && String(p.path) === path) {
                sel = app.getProjectViewSelection(views[i]);
                if (sel && sel.length) { found.push(sel); }
            }
        }
    } catch (e1) {}
    if (found.length > 1) { return { several: found.length }; }
    return found.length ? { items: found[0] } : null;
}

// Whether a file is video, by its extension: exts is a set from slExts, null for any media.
function slIsVideo(path, exts) {
    if (!exts) { return true; }
    var name = path.substring(path.lastIndexOf('/') + 1), dot = name.lastIndexOf('.');
    if (dot <= 0 || name.charAt(0) === '.') { return false; }
    return exts['e' + name.substring(dot + 1).toLowerCase()] === true;
}

function slExts(list) {
    if (!list || !list.length) { return null; }
    var out = {}, i;
    for (i = 0; i < list.length; i++) { out['e' + String(list[i]).toLowerCase()] = true; }
    return out;
}

// The ids among [{item, path}] that are not subclips: Premiere's own search, which can leave subclips out, finds them.
// One search per path, however many: what it finds are the selected items again, which this call already holds, so it
// hands out next to nothing new, where one search of every media item would hand out the whole project. About 2 ms a path.
function slNotSubclips(clips) {
    var keep = {}, i, j, list, done = {};
    for (i = 0; i < clips.length; i++) {
        if (done['p' + clips[i].path]) { continue; }
        done['p' + clips[i].path] = true;
        list = slSearch(app.project.rootItem, clips[i].path);
        for (j = 0; j < list.length; j++) { keep['n' + list[j].nodeId] = true; }
    }
    return keep;
}

// What a selection holds: selected bins by every clip in them, selected clips as they are, each item once, subclips
// left out. exts: the panel's video extensions, so a selection of only stills or sequences can be told apart.
// places: where it is, in first-seen order: a selected bin by its name, a selected clip by its bin, '' for the top.
function slPicked(sel, exts) {
    var out = { items: [], video: 0, bins: 0, clips: 0, sequences: 0, noPath: 0, subclips: 0, places: [], one: null }, seen = {}, placed = {}, loose = [], i, j, it, p, list, where;
    var place = function (name) {
        if (!placed['k' + name]) { placed['k' + name] = true; out.places.push(name); }
    };
    var take = function (item, path, bin) {
        var k = 'n' + item.nodeId;
        if (seen[k]) { return; }
        seen[k] = true;
        out.items.push({ id: String(item.nodeId), path: path, name: String(item.name), bin: bin === null ? slBinPath(item) : bin });
        if (slIsVideo(path, exts)) { out.video++; }
    };
    for (i = 0; i < sel.length; i++) {
        it = sel[i];
        if (it.type === 2) {
            out.bins++;
            place(String(it.name));
            list = slSearch(it, '/');
            for (j = 0; j < list.length; j++) {
                p = slMediaPath(list[j]);
                if (p) { take(list[j], p, null); }
            }
        } else if (it.isSequence()) {
            out.sequences++;
        } else {
            p = slMediaPath(it);
            if (p) { loose.push({ item: it, path: p }); } else { out.noPath++; }
        }
    }
    var keep = slNotSubclips(loose);
    for (i = 0; i < loose.length; i++) {
        it = loose[i].item;
        if (!keep['n' + it.nodeId]) { out.subclips++; continue; }
        out.clips++;
        where = slBinPath(it);
        take(it, loose[i].path, where);
        if (slIsVideo(loose[i].path, exts)) {
            place(slLastPart(where));
            out.one = out.one ? 'many' : it;
        }
    }
    if (out.one === 'many') { out.one = null; }
    return out;
}

// What changes when the Project panel selection changes, even by one clip in the middle of it, reading nothing of the
// items but their ids: the count and a 32-bit FNV-1a of every nodeId joined with ',', in selection order, 8 hex digits.
function slSig(got) {
    if (!got) { return ''; }
    if (got.several) { return 'several:' + got.several; }
    var sel = got.items, ids = [], i;
    for (i = 0; i < sel.length; i++) { ids.push(String(sel[i].nodeId)); }
    return sel.length + ':' + slFnv(ids.join(','));
}

// FNV-1a, 32 bits, in ES3: the multiply by 16777619 written as shifts, so no Math.imul and no precision lost.
function slFnv(text) {
    var h = 0x811c9dc5, i;
    for (i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
}

// ---------------------------------------------------------------- reads

var slOps = {};

slOps.ping = function () {
    return { ok: true, version: SELECT_HOST_VERSION, protocol: SELECT_HOST_PROTOCOL, premiere: String(app.version) };
};

slOps.status = function () {
    var st = slPlayback();
    return {
        ok: true,
        version: SELECT_HOST_VERSION,
        protocol: SELECT_HOST_PROTOCOL,
        premiere: String(app.version),
        project: slProjectInfo(),
        playback: st
    };
};

// The cheap call: the project in front and a signature of the Project panel selection. No guard, no QE, no walk. It still
// costs one item handed out per item selected (see above), so the panel asks when the editor comes to it (the pointer
// enters, focus, the panel shows again) rather than on a timer.
// Premiere can call a script back when the selection changes (app.bind('onSourceClipSelectedInProjectPanel', fn), 26.5.2),
// and the host doesn't use it: one function per event for every panel, so binding it takes it from any other extension;
// and a selection made by a script calls back once per item with the whole selection so far: setProjectViewSelection of
// 40 clips took 5 s with a callback bound, against 0.1 s without, and 500 took 13 minutes.
slOps.watch = function () {
    var project = slProjectInfo();
    return { ok: true, project: project, sig: project ? slSig(slSelection()) : '' };
};

// What Scan would read now: the Project panel selection, or the whole project when nothing is selected, when the
// selection holds no video clip, or with a.whole. a: {whole, fresh, exts: the panel's video extensions}. The whole
// project comes from the last walk while nothing in the project has changed (walked: false); whole and fresh walk again.
// kind: clips (at least one clip selected), bins (only bins), project, or several (two Project panels have a selection
// and none is current). name: the one clip selected. places: where the selection is, at most 3, and `more` beyond them.
// items: every master clip the target holds, each once, with its bin path; subclips and sequences are left out.
slOps.target = function (a) {
    var project = slProjectInfo();
    if (!project) { return slFail('no-project', 'No project is open.'); }
    var got = a && a.whole ? null : slSelection(), sig = slSig(got), exts = slExts(a && a.exts), out, picked, i, p, list;
    out = { ok: true, project: project, sig: sig, kind: 'project', name: null, places: [], more: 0, items: [], sequences: 0, noPath: 0, subclips: 0 };
    if (got && got.several) {
        out.kind = 'several';
        out.several = got.several;
        return out;
    }
    if (got) {
        picked = slPicked(got.items, exts);
        if (picked.video) {
            out.kind = picked.clips ? 'clips' : 'bins';
            out.name = picked.one ? String(picked.one.name) : null;
            out.places = picked.places.slice(0, 3);
            out.more = Math.max(0, picked.places.length - 3);
            out.items = picked.items;
            out.sequences = picked.sequences;
            out.noPath = picked.noPath;
            out.subclips = picked.subclips;
            return out;
        }
    }
    var whole = slWholeProject(project, !!(a && (a.whole || a.fresh)));
    out.items = whole.items;
    out.sequences = whole.sequences;
    out.walked = whole.walked;
    whole.walked = false;
    return out;
};

// The whole project's clips, kept from the last walk. Premiere nearly always keeps something selected, often a sequence,
// and each such selection means the whole project, so walking it again for every click would hand out every clip each
// time. The list is kept while the project and its undo history stand where they were: an import, a move, a deletion or
// a rename each add a step, and a selection adds none. fresh: walk again whatever (Scan Whole Project, or a.fresh).
var slWhole;
if (slWhole === undefined) { slWhole = null; }

function slUndoAt() {
    try {
        app.enableQE();
        var n = Number(qe.project.undoStackIndex());
        return isFinite(n) ? n : null;
    } catch (e) { return null; }
}

function slWholeProject(project, fresh) {
    var at = slUndoAt(), w = slWhole, list, i, p;
    if (!fresh && w && at !== null && w.at === at && w.path === project.path && w.id === project.id) { return w; }
    w = { path: project.path, id: project.id, at: at, items: [], sequences: 0, walked: true };
    list = slSearch(app.project.rootItem, '/');
    for (i = 0; i < list.length; i++) {
        p = slMediaPath(list[i]);
        if (p) { w.items.push(slRecord(list[i], p)); }
    }
    try { w.sequences = app.project.sequences.numSequences; } catch (e) {}
    slWhole = at === null ? null : w;
    return w;
}

// Every clip with media in the project, or in the selection. Subclips are left out: they are the master's media again.
// Each item says its bin path (Day 2/A cam), so search can find a clip by the bins it sits in.
slOps.collect = function (a) {
    var project = slProjectInfo();
    if (!project) { return slFail('no-project', 'No project is open.'); }
    slLetGo(null);
    var items = [], picked = null, list, i, p;
    if (a.mode === 'selection') {
        var got = slSelection();
        if (!got) { return slFail('no-selection', 'Nothing is selected in the Project panel.'); }
        if (got.several) { return slFail('several-selections', got.several + ' Project panels have clips selected.'); }
        var sel = slPicked(got.items, null);
        items = sel.items;
        picked = { clips: items.length, where: sel.places.slice(0, 4) };
        if (sel.subclips) { picked.subclips = sel.subclips; }
    } else {
        list = slSearch(app.project.rootItem, '/');
        for (i = 0; i < list.length; i++) {
            p = slMediaPath(list[i]);
            if (p) { items.push(slRecord(list[i], p)); }
        }
    }
    var sequences = 0;
    try { sequences = app.project.sequences.numSequences; } catch (e) {}
    return { ok: true, project: project, mode: a.mode, items: items, sequences: sequences, noPath: 0, picked: picked };
};

// The items whose media path is one of `paths`, for a write or an open: only those cross the bridge, not the whole
// project. ExtendScript cannot normalise Unicode, so the panel sends each path in every form it has. Subclips are left
// out, so no write ever reaches one.
slOps.find = function (a) {
    var project = slProjectInfo();
    if (!project) { return slFail('no-project', 'No project is open.'); }
    slLetGo(null);
    var found = slFindPaths(a.paths), items = [], i;
    for (i = 0; i < found.length; i++) { items.push(slRecord(found[i].item, found[i].path)); }
    return { ok: true, project: project, items: items };
};

// ---------------------------------------------------------------- source monitor and import

// The clip by the id collect or find gave, checked against its path, found by Premiere's search for that path alone.
// When the id is gone but the media is still in the project, its first item opens instead, and `id` says which.
// not-found: the media isn't in the project; the panel then finds it again or offers to import it.
slOps.open = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    if (!a.path) { return slFail('not-found', 'That clip is no longer in the project.'); }
    var found = slFindPaths([a.path]), it = null, i;
    for (i = 0; i < found.length; i++) {
        if (String(found[i].item.nodeId) === String(a.id)) { it = found[i].item; }
    }
    var by = 'id';
    if (!it && found.length) { it = found[0].item; by = 'path'; }
    if (!it) { return slFail('not-found', 'That clip is no longer in the project.'); }
    app.sourceMonitor.openProjectItem(it);
    return { ok: true, name: String(it.name), id: String(it.nodeId), by: by };
};

function slChildBin(parent, name, create) {
    var kids = parent.children, i;
    for (i = 0; i < kids.numItems; i++) {
        if (kids[i].type === 2 && String(kids[i].name) === name) { return kids[i]; }
    }
    return create ? parent.createBin(name) : null;
}

slOps.importClips = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    var bin = slChildBin(app.project.rootItem, a.bin, true);
    if (!bin) { return slFail('bin-failed', 'Could not create the bin ' + a.bin + '. Nothing was imported.'); }
    var ok = app.project.importFiles(a.paths, true, bin, false);
    var items = [];
    slWalk(bin, function (c) {
        if (c.isSequence()) { return; }
        var p = slMediaPath(c);
        if (p) { items.push(slRecord(c, p)); }
    });
    return { ok: true, imported: ok === true, items: items, bin: String(bin.name) };
};

// Selects these items in the project's Project panel, inside bins too, and reads the selection back. Nothing in the
// project changes, so it runs during playback too. a: {project, items: [[id, path]], at most SL_MOST_REVEAL}.
// Measured on 26.5.2: 100 clips in 0.24 s with no panel bound to the selection event. One that is bound (any extension
// can) is called back once per clip with the whole selection so far, so the cost grows with the square of the count:
// 40 clips took 5 s and 500 took 13 minutes. Hence a low ceiling.
var SL_MOST_REVEAL = 50;

slOps.reveal = function (a) {
    var g = slGuard(a.project, true);
    if (g) { return g; }
    if (!a.items || !a.items.length) { return slFail('empty', 'No clips to select.'); }
    if (a.items.length > SL_MOST_REVEAL) { return slFail('too-many', 'At most ' + SL_MOST_REVEAL + ' clips.'); }
    var r = slResolve(a, a.items), view = slViewOf(slProjectPath()), back = 0, i, j, sel, want = {};
    if (!r.found.length) { return slFail('not-found', 'None of these clips are in this project.', { skipped: r.skipped }); }
    if (view === null) { return slFail('no-view', 'No Project panel shows this project.'); }
    app.setProjectViewSelection(r.found, view);
    for (i = 0; i < r.found.length; i++) { want['n' + r.found[i].nodeId] = true; }
    sel = app.getProjectViewSelection(view) || [];
    for (j = 0; j < sel.length; j++) { if (want['n' + sel[j].nodeId]) { back++; } }
    return { ok: true, selected: back, asked: r.found.length, skipped: r.skipped };
};

function slViewOf(path) {
    var views = null, i, p;
    try { views = app.getProjectViewIDs(); } catch (e) {}
    for (i = 0; views && i < views.length; i++) {
        try { p = app.getProjectFromViewID(views[i]); } catch (e1) { p = null; }
        if (p && String(p.path) === path) { return views[i]; }
    }
    return null;
}

// The items pairs [[id, path]] name, in their order: by Premiere's search for a few, by the write's index for many.
function slResolve(a, pairs) {
    var found = [], skipped = [], i, it, items;
    if (pairs.length <= SL_FEW_PATHS) {
        for (i = 0; i < pairs.length; i++) {
            var hits = slFindPaths([String(pairs[i][1])]), j;
            it = null;
            for (j = 0; j < hits.length; j++) { if (String(hits[j].item.nodeId) === String(pairs[i][0])) { it = hits[j].item; } }
            if (it) { found.push(it); } else { skipped.push({ id: String(pairs[i][0]), error: 'no longer in the project' }); }
        }
        return { found: found, skipped: skipped };
    }
    items = slIndexFor(a).index.items;
    for (i = 0; i < pairs.length; i++) {
        it = slItem(items, pairs[i], skipped);
        if (it) { found.push(it); }
    }
    return { found: found, skipped: skipped };
}

// ---------------------------------------------------------------- writes

// The node ids a bin holds right now, read back after a move.
function slChildIds(bin) {
    var kids = bin.children, n = kids ? kids.numItems : 0, out = [], i;
    for (i = 0; i < n; i++) { out.push(String(kids[i].nodeId)); }
    return out;
}

// The bin an item sits in, as its treePath: the item's own treePath without its name. Text, so it hands nothing out.
function slWhereNow(it) {
    var t = String(it.treePath);
    return t.substring(0, t.lastIndexOf('\\'));
}

// The item a pair [id, path] names, or null with the reason added to `skipped`. Ids are small counters: a project
// reverted, or closed and opened again, can give an id to another clip, so the path must still match.
function slItem(items, pair, skipped) {
    var id = String(pair[0]), it = items['n' + id];
    if (!it) { skipped.push({ id: id, error: 'no longer in the project' }); return null; }
    if (slMediaPath(it) !== String(pair[1])) { skipped.push({ id: id, name: String(it.name), error: 'now a different clip' }); return null; }
    return it;
}

// Premiere keeps one undo step per item and only the last 50 steps (BE.Prefs.Undo.MaxLevels, measured on 26.5.2),
// so its undo cannot take back a batch. Each write therefore returns what it replaced, for slOps.restore.
// a: {project, items: [[id, path]], color, write: the panel's id for the whole write, final: this is its last batch}.
slOps.label = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    var cache = slIndexFor(a), items = cache.index.items, failed = [], skipped = [], before = [], changed = 0, i, it, id;
    for (i = 0; i < a.items.length; i++) {
        it = slItem(items, a.items[i], skipped);
        if (!it) { continue; }
        id = String(a.items[i][0]);
        try {
            var was = it.getColorLabel();
            it.setColorLabel(a.color);
            if (it.getColorLabel() === a.color) {
                changed++;
                before.push([id, was, String(a.items[i][1])]);
            } else {
                failed.push({ id: id, name: String(it.name), error: 'label did not change' });
            }
        } catch (e) { failed.push({ id: id, name: String(it.name), error: String(e) }); }
    }
    if (a.final) { slLetGo(a); }
    return { ok: true, changed: changed, failed: failed, skipped: skipped, index: { ms: cache.used ? 0 : cache.ms, reused: cache.used > 0 }, restore: { kind: 'label', color: a.color, items: before } };
};

function slXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A minimal packet with only our fields: Premiere merges it, and the clip's other metadata stays (tested on 26.5.2).
// Add Columns, which wrote these fields, is gone since 0.4; Undo Write still puts back what it wrote in 0.2 and 0.3.
function slPacket(fields, values) {
    var body = '', i, tag;
    for (i = 0; i < fields.length; i++) {
        tag = 'premierePrivateProjectMetaData:' + fields[i];
        body += '<' + tag + '>' + slXml(values[fields[i]] === null || values[fields[i]] === undefined ? '' : values[fields[i]]) + '</' + tag + '>';
    }
    return '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
        '<rdf:Description rdf:about="" xmlns:premierePrivateProjectMetaData="' + SELECT_NS + '">' + body +
        '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
}

function slUnxml(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// The current value of each field, '' when there is none.
function slReadFields(it, fields) {
    var xmp = String(it.getProjectMetadata()), out = {}, i, tag, s, e;
    for (i = 0; i < fields.length; i++) {
        tag = 'premierePrivateProjectMetaData:' + fields[i];
        s = xmp.indexOf('<' + tag + '>');
        e = xmp.indexOf('</' + tag + '>');
        out[fields[i]] = (s < 0 || e < 0) ? '' : slUnxml(xmp.substring(s + tag.length + 2, e));
    }
    return out;
}

// One batch of moves. The first batch makes the top bin, named from `root` and never over another bin, and later
// batches name it by `top`. A sub-bin is found by name under the top bin, or made. single: no sub-bins, every item goes
// into the top bin itself, and the one bucket keeps the name the panel gave it.
// a: {project, root, top, single, buckets: [{name, items: [[id, path]]}], write}.
slOps.bins = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    var root = app.project.rootItem, cache = slIndexFor(a), index = cache.index, top, name, n = 2;
    if (a.top) {
        top = index.bins['n' + a.top] || slTopBin(a.top);
        if (!top) { return slFail('bin-gone', 'The bin Select was filling is no longer in the project, so nothing more was moved.'); }
        name = String(top.name);
    } else {
        name = a.root;
        while (slChildBin(root, name, false)) { name = a.root + ' (' + (n++) + ')'; }
        top = root.createBin(name);
        if (!top) { return slFail('bin-failed', 'Could not create the bin ' + name + '. Nothing moved.'); }
        index.bins['n' + top.nodeId] = top;
    }
    var failed = [], skipped = [], before = [], moved = 0, report = [], i, j, it, sub, b, r, key, id, here;
    for (i = 0; i < a.buckets.length; i++) {
        b = a.buckets[i];
        // Clips may already have moved by now, so nothing below may throw past the return that carries `restore`.
        sub = null;
        try { sub = a.single ? top : slChildBin(top, b.name, true); } catch (e0) { failed.push({ id: null, error: 'could not create bin ' + b.name + ': ' + e0 }); continue; }
        if (!sub) {
            failed.push({ id: null, error: 'could not create bin ' + b.name });
            continue;
        }
        index.bins['n' + sub.nodeId] = sub;
        here = [];
        for (j = 0; j < b.items.length; j++) {
            it = slItem(index.items, b.items[j], skipped);
            if (!it) { continue; }
            id = String(b.items[j][0]);
            key = 'n' + id;
            try {
                var from = String(index.parents[key].nodeId);
                r = it.moveBin(sub);
                if (r === false) {
                    failed.push({ id: id, name: String(it.name), error: 'moveBin returned false' });
                } else {
                    here.push(id);
                    index.parents[key] = sub;
                    before.push([id, from, String(sub.nodeId), String(b.items[j][1])]);
                }
            } catch (e) { failed.push({ id: id, name: String(it.name), error: String(e) }); }
        }
        moved += here.length;
        report.push({ name: b.name, moved: here });
    }
    return { ok: true, root: name, top: String(top.nodeId), moved: moved, buckets: report, failed: failed, skipped: skipped, index: { ms: cache.used ? 0 : cache.ms, reused: cache.used > 0 }, restore: { kind: 'bins', top: String(top.nodeId), items: before } };
};

// After the last batch, or a Stop: what each bin under the top bin holds now, read from the project's own tree.
// clear: nothing was moved, so the bins are clutter with no Undo to clear them, and they go if they are empty.
// single: the top bin is the one bucket, reported under `name`, the bucket's name in the write.
slOps.binsCheck = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    slLetGo(a);
    var top = slTopBin(a.top), out = [], removed = null, kids, i, ids;
    if (!top) { return { ok: true, buckets: [], gone: true, binRemoved: null }; }
    kids = top.children;
    if (a.single) {
        ids = [];
        for (i = 0; i < kids.numItems; i++) { if (kids[i].type !== 2) { ids.push(String(kids[i].nodeId)); } }
        out.push({ name: a.name === undefined ? String(top.name) : String(a.name), ids: ids });
    }
    for (i = 0; !a.single && i < kids.numItems; i++) {
        if (kids[i].type === 2) {
            try { out.push({ name: String(kids[i].name), ids: slChildIds(kids[i]) }); } catch (e) { out.push({ name: String(kids[i].name), ids: null }); }
        }
    }
    if (a.clear) {
        try { removed = slDeleteIfEmpty(top); } catch (e1) { removed = false; }
    }
    return { ok: true, buckets: out, binRemoved: removed };
};

function slSame(a, b, names) {
    for (var i = 0; i < names.length; i++) {
        if (String(a[names[i]]) !== String(b[names[i]])) { return false; }
    }
    return true;
}

function slDeleteIfEmpty(bin) {
    var kids = bin.children, i;
    for (i = kids.numItems - 1; i >= 0; i--) {
        if (kids[i].type !== 2 || !slDeleteIfEmpty(kids[i])) { return false; }
    }
    return bin.deleteBin() !== false;
}

// ---------------------------------------------------------------- sequences

function slSequenceById(id) {
    var seqs = app.project.sequences, i;
    for (i = 0; i < seqs.numSequences; i++) {
        if (String(seqs[i].sequenceID) === String(id)) { return seqs[i]; }
    }
    return null;
}

function slNewSequence(before, name) {
    var seqs = app.project.sequences, i;
    for (i = 0; i < seqs.numSequences; i++) {
        if (!before.ids['s' + seqs[i].sequenceID] && String(seqs[i].name) === name) { return seqs[i]; }
    }
    return null;
}

function slSequenceIds() {
    var seqs = app.project.sequences, out = {}, i;
    for (i = 0; i < seqs.numSequences; i++) { out['s' + seqs[i].sequenceID] = true; }
    return { ids: out, count: seqs.numSequences };
}

// The project items on V1, in order: what Make Sequence placed, and how Undo tells whether anyone has worked in it.
function slV1(seq) {
    var out = [], clips, i, it;
    try {
        clips = seq.videoTracks[0].clips;
        for (i = 0; i < clips.numItems; i++) {
            it = null;
            try { it = clips[i].projectItem; } catch (e0) {}
            out.push(it ? String(it.nodeId) : '');
        }
    } catch (e) {}
    return out;
}

// How many clips V1 holds: a count, so no clip is handed out.
function slV1Count(seq) {
    try { return seq.videoTracks[0].clips.numItems; } catch (e) { return -1; }
}

function slSequenceSettings(seq) {
    var o = { width: null, height: null, fps: null, par: null }, s = null;
    try { s = seq.getSettings(); } catch (e) {}
    try { o.width = Number(s ? s.videoFrameWidth : seq.frameSizeHorizontal); o.height = Number(s ? s.videoFrameHeight : seq.frameSizeVertical); } catch (e1) {}
    try { o.fps = Math.round(254016000000 / Number(seq.timebase) * 1000) / 1000; } catch (e2) {}
    try { if (s && s.videoPixelAspectRatio) { o.par = String(s.videoPixelAspectRatio); } } catch (e3) {}
    return o;
}

// A new sequence of these clips, in this order, named `name`, at the top of the project (or in the top-level bin
// `bin`, made when missing). The name gets (2), (3)... when an item there already has it. Premiere takes the settings
// from the first clip, as its own New Sequence From Clip does. Every sequence already in the project stays as it was,
// which the call checks. open: show it in the Timeline when Premiere didn't already.
// a: {project, name, items: [[id, path]] in on-screen order, open, bin, write}.
var SL_MOST_SEQUENCE = 2000;

slOps.sequence = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    if (!a.items || a.items.length > SL_MOST_SEQUENCE) { return slFail('too-many', 'A sequence from Select holds at most 2,000 clips.'); }
    var t0 = slNow(), r = slResolve(a, a.items), steps = { find: slNow() - t0 };
    slLetGo(a);
    if (!r.found.length) { return slFail('empty', 'None of these clips are in this project.', { skipped: r.skipped }); }
    var into = app.project.rootItem, made = false, name = String(a.name), n = 2;
    if (a.bin) {
        into = slChildBin(app.project.rootItem, String(a.bin), false);
        if (!into) { into = app.project.rootItem.createBin(String(a.bin)); made = true; }
        if (!into) { return slFail('failed', 'Premiere didn\'t make the bin ' + a.bin + '. Nothing was changed.'); }
    }
    while (slChildNamed(into, name)) { name = a.name + ' (' + (n++) + ')'; }
    var before = slSequenceIds(), seq = null, t1 = slNow();
    try { seq = app.project.createNewSequenceFromClips(name, r.found, into); } catch (e) { seq = null; }
    // 26.5.2 returns the sequence. Should a version return nothing, a new sequence of that name is still the one made.
    if (!seq) { seq = slNewSequence(before, name); }
    steps.make = slNow() - t1;
    t1 = slNow();
    if (!seq || before.ids['s' + seq.sequenceID]) {
        if (made) { try { slDeleteIfEmpty(into); } catch (e1) {} }
        return slFail('failed', 'Premiere didn\'t make the sequence. Nothing was changed.', { skipped: r.skipped });
    }
    var after = slSequenceIds(), others = 0, k;
    for (k in before.ids) { if (before.ids.hasOwnProperty(k) && after.ids[k]) { others++; } }
    var v1 = slV1(seq), inOrder = v1.length === r.found.length, i, item = null, opened = false;
    for (i = 0; inOrder && i < v1.length; i++) { if (v1[i] !== String(r.found[i].nodeId)) { inOrder = false; } }
    try { item = seq.projectItem; } catch (e2) {}
    try { opened = !!app.project.activeSequence && String(app.project.activeSequence.sequenceID) === String(seq.sequenceID); } catch (e3) {}
    if (a.open && !opened) {
        try { app.project.openSequence(seq.sequenceID); } catch (e4) {}
        try { opened = String(app.project.activeSequence.sequenceID) === String(seq.sequenceID); } catch (e5) {}
    }
    var end = null;
    try { end = String(seq.end); } catch (e6) {}
    steps.check = slNow() - t1;
    var out = { ok: true, sequenceID: String(seq.sequenceID), id: item ? String(item.nodeId) : null, name: String(seq.name),
        clips: v1.length, inOrder: inOrder, settings: slSequenceSettings(seq), opened: opened, steps: steps,
        othersKept: others === before.count && after.count === before.count + 1, skipped: r.skipped,
        restore: { kind: 'sequence', items: [[String(seq.sequenceID), item ? String(item.nodeId) : null, String(seq.name), v1.length, end, slShape(seq)]] } };
    if (made) { out.bin = String(into.nodeId); out.restore.bin = out.bin; }
    return out;
};

function slChildNamed(parent, name) {
    var kids = parent.children, i;
    for (i = 0; i < kids.numItems; i++) { if (String(kids[i].name) === name) { return true; } }
    return false;
}

// What a sequence holds, told without handing out a clip or a project item: every track, the clips and transitions on
// each, its markers, its in and out, frame size, timebase and start. Make Sequence keeps it in the Undo record, and Undo
// Write deletes only a sequence that still says the same. A part that can't be read reads '?', at both ends.
// It can't see an effect, a keyframe or a level changed on a clip, or a trim that leaves a gap: those need every clip
// handed out. Premiere's Edit > Undo brings a deleted sequence back (one step, 26.5.2).
function slShape(seq) {
    var read = function (f) { try { return String(f()); } catch (e) { return '?'; } };
    var tracks = function (tag, list) {
        var n = list.numTracks, out = [tag + n], k;
        for (k = 0; k < n; k++) { out.push(slTrackShape(list[k], read)); }
        return out.join(',');
    };
    var parts = [];
    parts.push(read(function () { return tracks('v', seq.videoTracks); }));
    parts.push(read(function () { return tracks('a', seq.audioTracks); }));
    parts.push('m' + read(function () { return seq.markers.numMarkers; }));
    parts.push('io' + read(function () { return seq.getInPoint(); }) + ',' + read(function () { return seq.getOutPoint(); }));
    parts.push('f' + read(function () { return seq.frameSizeHorizontal; }) + 'x' + read(function () { return seq.frameSizeVertical; }) + '@' + read(function () { return seq.timebase; }));
    parts.push('z' + read(function () { return seq.zeroPoint; }));
    parts.push('e' + read(function () { return seq.end; }));
    return parts.join('|');
}

function slTrackShape(track, read) {
    return read(function () { return track.clips.numItems; }) + '/' + read(function () { return track.transitions.numItems; });
}

// How many times other sequences use this one, from the Project panel's Video Usage and Audio Usage, which Premiere keeps
// in the item's own metadata: text, so nothing is handed out. deleteSequence on a sequence used in another one deletes it
// with no dialog and takes it out of that timeline too (26.5.2), so a used sequence stays. null: unreadable.
function slUsage(item) {
    var x, m, n = 0, re = /<premierePrivateProjectMetaData:Column\.Intrinsic\.(?:Video|Audio)Usage>([^<]*)</g;
    try { x = String(item.getProjectMetadata()); } catch (e) { return null; }
    while ((m = re.exec(x)) !== null) { n += Number(m[1]) || 0; }
    return n;
}

var SL_SEQ_CHANGED = 'The sequence has changed. It stays.';
var SL_SEQ_USED = 'The sequence is in another sequence. It stays.';

// Removes a sequence Make Sequence made, found by its sequenceID only, while it is the same object (its project item
// keeps its id), still holds what it was made with (name, clips on V1, end, and its whole shape, above) and no other
// sequence uses it, so nothing an editor has worked in since is removed.
// e: [sequenceID, nodeId, name, clips, end, shape]. Returns removed, skipped (gone already, or kept, with why), or error.
function slRemoveSequence(e) {
    var seq = slSequenceById(e[0]), item = null, end = null, used;
    if (!seq) { return { skipped: true, error: 'gone' }; }
    try { item = seq.projectItem; } catch (e0) {}
    try { end = String(seq.end); } catch (e1) {}
    if ((e[1] && (!item || String(item.nodeId) !== String(e[1]))) || String(seq.name) !== String(e[2]) || slV1Count(seq) !== e[3] || (e[4] !== null && end !== String(e[4])) ||
        typeof e[5] !== 'string' || slShape(seq) !== e[5]) {
        return { skipped: true, kept: true, error: SL_SEQ_CHANGED };
    }
    used = item ? slUsage(item) : null;
    if (used !== 0) { return { skipped: true, kept: true, error: SL_SEQ_USED }; }
    var res = null;
    try { res = app.project.deleteSequence(seq); } catch (e2) { return { error: String(e2) }; }
    if (slSequenceById(e[0])) { return { error: 'did not go' }; }
    return { removed: true, answered: res };
}

// ---------------------------------------------------------------- Undo Write

// Puts back what a write replaced, in batches like the write. An item changed by anyone since that write is left alone
// and counted. remaining: what failed and can be tried again. a: {project, restore, final, write}.
slOps.restore = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    var r = a.restore, failed = [], left = [], restored = 0, skipped = 0, i, e, it, removed = null, cache, index, items;
    // Ids are small counters, so a project reopened since the write could give one to another clip.
    var sameClip = function (item, path) { return !path || slMediaPath(item) === path; };
    var missed = function (entry, id, item, error) {
        failed.push({ id: id, name: String(item.name), error: error });
        left.push(entry);
    };
    if (r.kind === 'sequence') {
        // kept: the sequences left alone because they changed or are used, with the words why. note: the first of them.
        var kept = [];
        for (i = 0; i < r.items.length; i++) {
            var s = slRemoveSequence(r.items[i]);
            if (s.removed) { restored++; } else if (s.skipped) {
                skipped++;
                if (s.kept) { kept.push({ id: r.items[i][0], name: r.items[i][2], why: s.error }); }
            } else {
                failed.push({ id: r.items[i][0], name: r.items[i][2], error: s.error });
                left.push(r.items[i]);
            }
        }
        // A bin made for it goes once it is empty.
        if (r.bin && a.final !== false) {
            var bin = slTopBin(r.bin);
            if (bin) { try { removed = bin.children.numItems === 0 && bin.deleteBin() !== false && !slTopBin(r.bin); } catch (e5) { removed = false; } }
        }
    } else if (r.kind === 'label') {
        items = slIndexFor(a).index.items;
        for (i = 0; i < r.items.length; i++) {
            e = r.items[i];
            it = items['n' + e[0]];
            if (!it) { failed.push({ id: e[0], error: 'not in the project' }); continue; }
            try {
                if (!sameClip(it, e[2]) || it.getColorLabel() !== r.color) { skipped++; continue; }
                it.setColorLabel(e[1]);
                if (it.getColorLabel() === e[1]) { restored++; } else { missed(e, e[0], it, 'label did not go back'); }
            } catch (e1) { missed(e, e[0], it, String(e1)); }
        }
    } else if (r.kind === 'columns') {
        // Written by Add Columns in 0.2 or 0.3.
        items = slIndexFor(a).index.items;
        for (i = 0; i < r.items.length; i++) {
            e = r.items[i];
            it = items['n' + e.id];
            if (!it) { failed.push({ id: e.id, error: 'not in the project' }); continue; }
            try {
                if (!sameClip(it, e.path) || !slSame(slReadFields(it, r.fields), e.wrote, r.fields)) { skipped++; continue; }
                it.setProjectMetadata(slPacket(r.fields, e.was), r.fields);
                if (slSame(slReadFields(it, r.fields), e.was, r.fields)) { restored++; } else { missed(e, e.id, it, 'values did not go back'); }
            } catch (e2) { missed(e, e.id, it, String(e2)); }
        }
    } else if (r.kind === 'bins') {
        cache = slIndexFor(a);
        index = cache.index;
        // Where an item sits is read from its own treePath, before and after the move: text, where the bin's list of
        // items would hand out every item in it.
        var sent = [], key, back, where;
        for (i = 0; i < r.items.length; i++) {
            e = r.items[i];
            key = 'n' + e[0];
            it = index.items[key];
            back = index.bins['n' + e[1]];
            where = index.bins['n' + e[2]];
            if (!it) { failed.push({ id: e[0], error: 'not in the project' }); continue; }
            if (!sameClip(it, e[3]) || !where || slWhereNow(it) !== String(where.treePath)) { skipped++; continue; }
            if (!back) { failed.push({ id: e[0], name: String(it.name), error: 'its original bin is gone' }); continue; }
            try { it.moveBin(back); sent.push(e); } catch (e3) { missed(e, e[0], it, String(e3)); }
        }
        // moveBin returns 0 on success and can say so without moving, so only where the item sits now counts.
        for (i = 0; i < sent.length; i++) {
            e = sent[i];
            key = 'n' + e[0];
            back = index.bins['n' + e[1]];
            if (slWhereNow(index.items[key]) === String(back.treePath)) { restored++; index.parents[key] = back; } else { missed(e, e[0], index.items[key], 'did not move back'); }
        }
        // The SELECT bin goes with the last batch of an Undo, once it is empty.
        var top = slTopBin(r.top);
        if (top && a.final !== false) {
            try { slDeleteIfEmpty(top); } catch (e4) {}
            removed = !slTopBin(r.top);
        }
    } else {
        return slFail('unknown-restore', 'Unknown restore kind: ' + r.kind);
    }
    if (a.final !== false) { slLetGo(a); }
    var remaining = null;
    if (left.length) {
        remaining = { kind: r.kind, items: left };
        if (r.color !== undefined) { remaining.color = r.color; }
        if (r.fields) { remaining.fields = r.fields; }
        if (r.top) { remaining.top = r.top; }
        if (r.bin) { remaining.bin = r.bin; }
    }
    var answer = { ok: true, restored: restored, skipped: skipped, failed: failed, remaining: remaining, binRemoved: removed };
    if (r.kind === 'sequence') {
        answer.kept = kept;
        answer.note = kept.length ? kept[0].why : null;
    }
    return answer;
};

// ---------------------------------------------------------------- the one entry point

function slCall(fn, json) {
    var out, t0 = slNow();
    try {
        if (!slOps.hasOwnProperty(fn)) {
            out = slFail('unknown-call', 'Unknown host call: ' + fn);
        } else {
            out = slOps[fn](json ? eval('(' + json + ')') : {});
        }
    } catch (e) {
        out = slFail('host-error', String(e) + (e && e.line ? ' (line ' + e.line + ')' : ''));
    }
    out.ms = slNow() - t0;
    return slJson(out);
}
