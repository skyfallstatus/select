// Select ExtendScript host. ES3 only: no JSON, no Array.indexOf, no reserved words as names.
// The panel calls one function, slCall(fn, jsonArgs), which always returns a JSON string in pure ASCII.
// Every write does all its work in one call and checks playback, dialogs and the project in that same call.
// Nothing here renames a clip, touches a file on disk or touches a sequence.

var SELECT_HOST_VERSION = '0.1.0';
var SELECT_NS = 'http://ns.adobe.com/premierePrivateProjectMetaData/1.0/';

// ---------------------------------------------------------------- JSON out (ASCII only)

function slQuote(s) {
    s = String(s);
    if (/^[\x20\x21\x23-\x5b\x5d-\x7e]*$/.test(s)) { return '"' + s + '"'; }
    var out = '"', i, c, h;
    for (i = 0; i < s.length; i++) {
        c = s.charCodeAt(i);
        if (c === 34) { out += '\\"'; }
        else if (c === 92) { out += '\\\\'; }
        else if (c < 32 || c > 126) { h = c.toString(16); out += '\\u' + '0000'.substring(h.length) + h; }
        else { out += s.charAt(i); }
    }
    return out + '"';
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

// null when a write may run, else the refusal to return. Unknown is refused.
function slGuard(expectProject) {
    var path = slProjectPath();
    if (!path) { return slFail('no-project', 'No project is open. Nothing was written.'); }
    if (expectProject && path !== expectProject) {
        return slFail('wrong-project', 'The project in front is ' + path + ', not the one scanned. Nothing was written.', { active: path });
    }
    var st = slPlayback();
    if (st.modal) { return slFail('modal', 'A Premiere dialog is open. Close it first. Nothing was written.', { playback: st }); }
    if (st.modal === null) { return slFail('modal-unknown', 'Premiere did not confirm that no dialog is open, so nothing was written.', { playback: st }); }
    if (st.program === true || st.source === true) {
        return slFail('playing', 'Playback is running. Stop it and try again. Nothing was written.', { playback: st });
    }
    if (st.program !== false || st.source !== false) {
        return slFail('playback-unknown', 'Premiere did not confirm that playback is stopped, so nothing was written.', { playback: st });
    }
    return null;
}

// ---------------------------------------------------------------- walking the project

function slWalk(item, fn) {
    var kids = item.children, n = kids ? kids.numItems : 0, i, c;
    for (i = 0; i < n; i++) {
        c = kids[i];
        if (c.type === 2) { slWalk(c, fn); } else { fn(c); }
    }
}

// Built once per call. Ids are the only way the panel names a clip to a write.
function slIndex() {
    var index = { items: {}, parents: {}, bins: {} };
    var root = app.project.rootItem;
    index.bins['n' + root.nodeId] = root;
    (function walk(bin) {
        var kids = bin.children, n = kids ? kids.numItems : 0, i, c, id;
        for (i = 0; i < n; i++) {
            c = kids[i];
            id = 'n' + c.nodeId;
            if (c.type === 2) {
                index.bins[id] = c;
                walk(c);
            } else {
                index.items[id] = c;
                index.parents[id] = bin;
            }
        }
    }(root));
    return index;
}

function slClipRecord(c, out) {
    var path = '';
    if (c.isSequence()) { out.sequences++; return; }
    try { path = String(c.getMediaPath() || ''); } catch (e) {}
    if (!path) { out.noPath++; return; }
    out.items.push({ id: String(c.nodeId), path: path, name: String(c.name) });
}

function slSelection() {
    var sel = null, views, i;
    try { sel = app.getCurrentProjectViewSelection(); } catch (e) {}
    if (sel && sel.length) { return sel; }
    // Focus is on this panel, so the "current" view can be empty while a Project panel still has a selection.
    var path = slProjectPath();
    try {
        views = app.getProjectViewIDs();
        for (i = 0; views && i < views.length; i++) {
            var p = app.getProjectFromViewID(views[i]);
            if (p && String(p.path) === path) {
                sel = app.getProjectViewSelection(views[i]);
                if (sel && sel.length) { return sel; }
            }
        }
    } catch (e1) {}
    return null;
}

// ---------------------------------------------------------------- reads

var slOps = {};

slOps.ping = function () {
    return { ok: true, version: SELECT_HOST_VERSION, premiere: String(app.version) };
};

slOps.status = function () {
    var path = slProjectPath(), st = slPlayback();
    return {
        ok: true,
        version: SELECT_HOST_VERSION,
        premiere: String(app.version),
        project: path ? { path: path, name: slProjectName() } : null,
        playback: st
    };
};

slOps.collect = function (a) {
    var path = slProjectPath();
    if (!path) { return slFail('no-project', 'No project is open.'); }
    var t0 = new Date().getTime();
    var out = { items: [], sequences: 0, noPath: 0 };
    var add = function (c) { slClipRecord(c, out); };
    if (a.mode === 'selection') {
        var sel = slSelection(), i;
        if (!sel) { return slFail('no-selection', 'Nothing is selected in the Project panel. Select clips or a bin, or choose Project.'); }
        var seen = {}, unique = function (c) {
            var k = 'n' + c.nodeId;
            if (!seen[k]) { seen[k] = true; add(c); }
        };
        for (i = 0; i < sel.length; i++) {
            if (sel[i].type === 2) { slWalk(sel[i], unique); } else { unique(sel[i]); }
        }
    } else {
        slWalk(app.project.rootItem, add);
    }
    return {
        ok: true,
        project: { path: path, name: slProjectName() },
        mode: a.mode,
        items: out.items,
        sequences: out.sequences,
        noPath: out.noPath,
        ms: new Date().getTime() - t0
    };
};

// ---------------------------------------------------------------- source monitor and import

slOps.open = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    var it = slIndex().items['n' + a.id];
    if (!it) { return slFail('not-found', 'That clip is no longer in the project.'); }
    app.sourceMonitor.openProjectItem(it);
    return { ok: true, name: String(it.name) };
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
    var t0 = new Date().getTime();
    var bin = slChildBin(app.project.rootItem, a.bin, true);
    if (!bin) { return slFail('bin-failed', 'Could not create the bin ' + a.bin + '. Nothing was imported.'); }
    var ok = app.project.importFiles(a.paths, true, bin, false);
    var out = { items: [], sequences: 0, noPath: 0 };
    slWalk(bin, function (c) { slClipRecord(c, out); });
    return { ok: true, imported: ok === true, items: out.items, bin: String(bin.name), ms: new Date().getTime() - t0 };
};

// ---------------------------------------------------------------- writes

// The node ids a bin holds right now, read back after a move.
function slChildIds(bin) {
    var kids = bin.children, n = kids ? kids.numItems : 0, out = [], i;
    for (i = 0; i < n; i++) { out.push(String(kids[i].nodeId)); }
    return out;
}

function slMediaPath(it) {
    try { return String(it.getMediaPath() || ''); } catch (e) { return ''; }
}

// Premiere keeps one undo step per item and only the last 50 steps (BE.Prefs.Undo.MaxLevels, measured on 26.5.2),
// so its undo cannot take back a batch. Each write therefore returns what it replaced, for slOps.restore.
slOps.label = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    var t0 = new Date().getTime();
    var items = slIndex().items, failed = [], before = [], changed = 0, i, it;
    for (i = 0; i < a.ids.length; i++) {
        it = items['n' + a.ids[i]];
        if (!it) { failed.push({ id: a.ids[i], error: 'not in the project' }); continue; }
        try {
            var was = it.getColorLabel();
            it.setColorLabel(a.color);
            if (it.getColorLabel() === a.color) {
                changed++;
                before.push([a.ids[i], was, slMediaPath(it)]);
            } else {
                failed.push({ id: a.ids[i], name: String(it.name), error: 'label did not change' });
            }
        } catch (e) { failed.push({ id: a.ids[i], name: String(it.name), error: String(e) }); }
    }
    return { ok: true, changed: changed, failed: failed, ms: new Date().getTime() - t0, restore: { kind: 'label', color: a.color, items: before } };
};

function slXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A minimal packet with only our fields: Premiere merges it, and the clip's other metadata stays (tested on 26.5.2).
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

function slField(block, tag) {
    var open = '<' + tag + '>', s = block.indexOf(open), e = block.indexOf('</' + tag + '>');
    return (s < 0 || e < 0) ? null : block.substring(s + open.length, e);
}

// setProjectPanelMetadata takes the complete list of columns to display and hides everything else: passing what
// getProjectPanelMetadata returned turned on all 460 columns (26.5.2). So rebuild the list from the columns shown
// now, using Premiere's own blocks, and add ours. Premiere picks the order; custom columns land after the built-in ones.
function slShowColumns(sample, fields) {
    var shown = eval('(' + sample.getProjectColumnsMetadata() + ')');
    var chunks = String(app.project.getProjectPanelMetadata()).split('<metadata_path>');
    var byKey = {}, i, b, key, id, ns, have = {}, blocks = [], added = 0;
    for (i = 1; i < chunks.length; i++) {
        b = '<metadata_path>' + chunks[i].substring(0, chunks[i].indexOf('</metadata_path>')) + '</metadata_path>';
        byKey[slField(b, 'namespace') + '|' + slField(b, 'entry_name')] = b;
    }
    for (i = 0; i < shown.length; i++) {
        id = String(shown[i].ColumnID);
        ns = String(shown[i].ColumnPath);
        if (id.indexOf(ns) === 0) { id = id.substring(ns.length); }
        key = ns + '|' + id;
        if (!byKey[key]) { return { shown: false, warning: 'Project panel column ' + id + ' could not be matched, so the columns were left as they were.' }; }
        have[key] = true;
        blocks.push(byKey[key]);
    }
    for (i = 0; i < fields.length; i++) {
        key = SELECT_NS + '|' + fields[i];
        if (have[key]) { continue; }
        if (!byKey[key]) { return { shown: false, warning: 'Field ' + fields[i] + ' is not in the schema, so the columns were left as they were.' }; }
        blocks.push(byKey[key]);
        added++;
    }
    if (!added) { return { shown: true, added: 0, columns: blocks.length }; }
    var r = app.project.setProjectPanelMetadata("<?xml version='1.0'?>\n<md.paths version='1.0'>\n" + blocks.join('\n') + '\n</md.paths>\n');
    if (r === false) { return { shown: false, added: added, columns: blocks.length }; }
    // Read the list back: a set call that does nothing still returns without complaint.
    var after = eval('(' + sample.getProjectColumnsMetadata() + ')'), seen, j;
    for (i = 0; i < fields.length; i++) {
        seen = false;
        for (j = 0; j < after.length; j++) {
            if (String(after[j].ColumnID).indexOf(fields[i]) !== -1) { seen = true; break; }
        }
        if (!seen) { return { shown: false, added: added, columns: blocks.length, warning: 'Premiere did not show the column ' + fields[i] + '.' }; }
    }
    return { shown: true, added: added, columns: blocks.length };
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

slOps.columns = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    var t0 = new Date().getTime();
    var names = [], i, j, it, sample = null;
    for (i = 0; i < a.fields.length; i++) {
        names.push(a.fields[i].name);
        // Adding a field that already exists returns undefined and changes nothing.
        app.project.addPropertyToProjectMetadataSchema(a.fields[i].name, a.fields[i].label, 2);
    }
    var items = slIndex().items, failed = [], before = [], changed = 0, matched = 0, row;
    for (i = 0; i < a.rows.length; i++) {
        row = a.rows[i];
        for (j = 0; j < row.ids.length; j++) {
            it = items['n' + row.ids[j]];
            if (!it) { failed.push({ id: row.ids[j], error: 'not in the project' }); continue; }
            try {
                var was = slReadFields(it, names);
                if (it.setProjectMetadata(slPacket(names, row.values), names) === false) {
                    failed.push({ id: row.ids[j], name: String(it.name), error: 'setProjectMetadata returned false' });
                } else {
                    changed++;
                    sample = it;
                    before.push({ id: row.ids[j], wrote: row.values, was: was, path: slMediaPath(it) });
                    if (slSame(slReadFields(it, names), row.values, names)) { matched++; }
                }
            } catch (e) { failed.push({ id: row.ids[j], name: String(it.name), error: String(e) }); }
        }
    }
    var columns = { shown: false };
    if (sample && a.show !== false) {
        try { columns = slShowColumns(sample, names); }
        catch (e1) { columns = { shown: false, warning: String(e1) }; }
    }
    return { ok: true, changed: changed, matched: matched, failed: failed, columns: columns, ms: new Date().getTime() - t0, restore: { kind: 'columns', fields: names, items: before } };
};

slOps.bins = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    var t0 = new Date().getTime();
    var root = app.project.rootItem, name = a.root, n = 2;
    while (slChildBin(root, name, false)) { name = a.root + ' (' + (n++) + ')'; }
    var top = root.createBin(name);
    if (!top) { return slFail('bin-failed', 'Could not create the bin ' + name + '. Nothing moved.'); }
    var index = slIndex(), failed = [], before = [], moved = 0, report = [], subs = [], i, j, it, sub, b, r, key;
    for (i = 0; i < a.buckets.length; i++) {
        b = a.buckets[i];
        // Clips may already have moved by now, so nothing below may throw past the return that carries `restore`.
        sub = null;
        try { sub = top.createBin(b.name); } catch (e0) { failed.push({ id: null, error: 'could not create bin ' + b.name + ': ' + e0 }); continue; }
        if (!sub) {
            failed.push({ id: null, error: 'could not create bin ' + b.name });
            continue;
        }
        var here = 0;
        for (j = 0; j < b.ids.length; j++) {
            key = 'n' + b.ids[j];
            it = index.items[key];
            if (!it) { failed.push({ id: b.ids[j], error: 'not in the project' }); continue; }
            try {
                var from = String(index.parents[key].nodeId);
                r = it.moveBin(sub);
                if (r === false) {
                    failed.push({ id: b.ids[j], name: String(it.name), error: 'moveBin returned false' });
                } else {
                    here++;
                    before.push([b.ids[j], from, String(sub.nodeId), slMediaPath(it)]);
                }
            } catch (e) { failed.push({ id: b.ids[j], name: String(it.name), error: String(e) }); }
        }
        moved += here;
        report.push({ name: b.name, moved: here });
        subs.push(sub);
    }
    for (i = 0; i < subs.length; i++) {
        try { report[i].ids = slChildIds(subs[i]); } catch (e1) { report[i].ids = null; }
    }
    if (!moved) {
        // Nothing went in, so the bins are clutter with no Undo to clear them.
        var cleared = false;
        try { cleared = slDeleteIfEmpty(top); } catch (e2) {}
        return { ok: true, root: name, moved: 0, buckets: report, failed: failed, binRemoved: cleared, ms: new Date().getTime() - t0, restore: null };
    }
    return { ok: true, root: name, moved: moved, buckets: report, failed: failed, ms: new Date().getTime() - t0, restore: { kind: 'bins', top: String(top.nodeId), items: before } };
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

// Puts back what a write replaced. An item changed by anyone since that write is left alone and counted.
slOps.restore = function (a) {
    var g = slGuard(a.project);
    if (g) { return g; }
    var t0 = new Date().getTime();
    var index = slIndex(), items = index.items, r = a.restore, failed = [], left = [], restored = 0, skipped = 0, i, e, it, removed = null;
    // Ids are small counters, so a project reopened since the write could give one to another clip.
    var sameClip = function (item, path) { return !path || slMediaPath(item) === path; };
    var missed = function (entry, id, item, error) {
        failed.push({ id: id, name: String(item.name), error: error });
        left.push(entry);
    };
    if (r.kind === 'label') {
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
        for (i = 0; i < r.items.length; i++) {
            e = r.items[i];
            var key = 'n' + e[0], back = index.bins['n' + e[1]];
            it = items[key];
            if (!it) { failed.push({ id: e[0], error: 'not in the project' }); continue; }
            if (!sameClip(it, e[3]) || String(index.parents[key].nodeId) !== e[2]) { skipped++; continue; }
            if (!back) { failed.push({ id: e[0], name: String(it.name), error: 'its original bin is gone' }); continue; }
            try { it.moveBin(back); } catch (e3) { missed(e, e[0], it, String(e3)); }
        }
        // moveBin returns 0 on success and can say so without moving, so only the project's own tree counts.
        var now = slIndex(), done = {};
        for (i = 0; i < left.length; i++) { done['n' + left[i][0]] = true; }
        for (i = 0; i < r.items.length; i++) {
            e = r.items[i];
            key = 'n' + e[0];
            it = items[key];
            if (!it || done[key] || !index.bins['n' + e[1]] || !sameClip(it, e[3]) || String(index.parents[key].nodeId) !== e[2]) { continue; }
            if (now.parents[key] && String(now.parents[key].nodeId) === e[1]) { restored++; } else { missed(e, e[0], it, 'did not move back'); }
        }
        var top = now.bins['n' + r.top];
        if (top) {
            try { slDeleteIfEmpty(top); } catch (e4) {}
            removed = !slIndex().bins['n' + r.top];
        }
    } else {
        return slFail('unknown-restore', 'Unknown restore kind: ' + r.kind);
    }
    var remaining = null;
    if (left.length) {
        remaining = { kind: r.kind, items: left };
        if (r.color !== undefined) { remaining.color = r.color; }
        if (r.fields) { remaining.fields = r.fields; }
        if (r.top) { remaining.top = r.top; }
    }
    return { ok: true, restored: restored, skipped: skipped, failed: failed, remaining: remaining, binRemoved: removed, ms: new Date().getTime() - t0 };
};

// ---------------------------------------------------------------- the one entry point

function slCall(fn, json) {
    var out;
    try {
        if (!slOps.hasOwnProperty(fn)) {
            out = slFail('unknown-call', 'Unknown host call: ' + fn);
        } else {
            out = slOps[fn](json ? eval('(' + json + ')') : {});
        }
    } catch (e) {
        out = slFail('host-error', String(e) + (e && e.line ? ' (line ' + e.line + ')' : ''));
    }
    return slJson(out);
}
