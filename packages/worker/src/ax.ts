import type { Page } from 'patchright';
import type { FieldKind, FieldSpec } from './types.ts';

/**
 * Accessibility-tree (ARIA) reader — the middle tier between the DOM scan and
 * the vision tier. Reads Chrome's computed accessibility tree over CDP, so it
 * sees controls the per-ATS DOM scanner under-reads: ARIA-role widgets
 * (role="textbox"/"combobox"/…) with no matching native <input>/<select>. The
 * accessible name Chrome computes IS the field label — no DOM label-hunting.
 *
 * Runs on the EMPTY pre-fill page and sends nothing to any model (PII-safe).
 * Never-silent-fail: any CDP error returns [] so the caller falls to vision.
 */

/** ARIA control roles → FieldSpec kind. Mirrors the roles the bench measured. */
const ROLE_KIND: Record<string, FieldKind> = {
  textbox: 'text',
  searchbox: 'text',
  spinbutton: 'text',
  slider: 'text',
  combobox: 'select',
  listbox: 'select',
  checkbox: 'checkbox',
  switch: 'checkbox',
  menuitemcheckbox: 'checkbox',
  radio: 'radio',
  menuitemradio: 'radio',
  radiogroup: 'radio',
};

/** Roles whose accessible name is an option label of a parent control. */
const OPTION_ROLES = new Set(['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'radio']);

/** Roles that own a set of option children (collapse to one field + options). */
const OPTION_PARENT_ROLES = new Set(['combobox', 'listbox', 'radiogroup']);

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

function roleOf(n: AXNode): string {
  return (n.role?.value as string) || '';
}

function nameOf(n: AXNode): string {
  return ((n.name?.value as string) || '').replace(/\s+/g, ' ').trim();
}

function isRequired(n: AXNode): boolean {
  return (n.properties || []).some((p) => p.name === 'required' && p.value?.value === true);
}

/** Collect option labels from a control's descendants (handles native <select>,
 *  whose <option>s are nested, and listbox/radiogroup, whose options are direct
 *  children). Records visited option nodeIds so they aren't emitted standalone. */
function collectOptions(
  start: AXNode,
  byId: Map<string, AXNode>,
  consumed: Set<string>,
): string[] {
  const out: string[] = [];
  const walk = (id: string): void => {
    const node = byId.get(id);
    if (!node) return;
    if (OPTION_ROLES.has(roleOf(node))) {
      const label = nameOf(node);
      if (label) out.push(label);
      consumed.add(node.nodeId);
    }
    for (const childId of node.childIds || []) walk(childId); // in document order
  };
  for (const childId of start.childIds || []) walk(childId);
  return out;
}

/** Build a stable CSS selector from a node's tag + attributes. Mirrors engine.ts
 *  `sel()`: prefer #id, else tag[name="…"]. Returns '' when neither is present. */
function selectorFrom(localName: string, attrs: Record<string, string>): string {
  if (attrs.id) {
    return /^[A-Za-z_][\w-]*$/.test(attrs.id)
      ? `#${attrs.id}`
      : `[id="${attrs.id.replace(/"/g, '\\"')}"]`;
  }
  if (attrs.name) return `${localName.toLowerCase()}[name="${attrs.name.replace(/"/g, '\\"')}"]`;
  return '';
}

function attrsToMap(flat: string[] | undefined): Record<string, string> {
  const m: Record<string, string> = {};
  if (!flat) return m;
  for (let i = 0; i + 1 < flat.length; i += 2) m[flat[i]] = flat[i + 1];
  return m;
}

export async function axScanForm(page: Page): Promise<FieldSpec[]> {
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch {
    return []; // CDP unavailable → caller falls to vision
  }
  try {
    // getDocument primes the backend→frontend node map so pushNodesByBackendIds works.
    await cdp.send('DOM.enable');
    await cdp.send('DOM.getDocument', { depth: -1 });
    await cdp.send('Accessibility.enable');
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AXNode[] };

    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const consumed = new Set<string>();

    // Pass 1: option-owning controls consume their option descendants so those
    // aren't re-emitted as standalone radio/option fields.
    const optionsByNode = new Map<string, string[]>();
    for (const n of nodes) {
      if (n.ignored) continue;
      if (OPTION_PARENT_ROLES.has(roleOf(n))) {
        optionsByNode.set(n.nodeId, collectOptions(n, byId, consumed));
      }
    }

    // Pass 2: gather control candidates (skip ignored + consumed option nodes).
    const candidates: Array<{ node: AXNode; kind: FieldKind }> = [];
    for (const n of nodes) {
      if (n.ignored || consumed.has(n.nodeId)) continue;
      if (n.backendDOMNodeId == null) continue;
      const kind = ROLE_KIND[roleOf(n)];
      if (!kind) continue;
      candidates.push({ node: n, kind });
    }
    if (candidates.length === 0) return [];

    // Resolve each candidate's backend node to a stable selector via the DOM domain.
    const { nodeIds } = (await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: candidates.map((c) => c.node.backendDOMNodeId!),
    })) as { nodeIds: number[] };

    const out: FieldSpec[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const domNodeId = nodeIds[i];
      if (!domNodeId) continue; // unresolved backend node → drop
      let localName = '';
      let attrs: Record<string, string> = {};
      try {
        const { node } = (await cdp.send('DOM.describeNode', { nodeId: domNodeId })) as {
          node: { localName?: string; attributes?: string[] };
        };
        localName = node.localName || '';
        attrs = attrsToMap(node.attributes);
      } catch {
        continue;
      }
      const selector = selectorFrom(localName, attrs);
      if (!selector) continue; // no stable selector → never emit an unfillable field

      const { node, kind } = candidates[i];
      const options = optionsByNode.get(node.nodeId);
      out.push({
        kind,
        label: nameOf(node),
        name: attrs.name || undefined,
        selector,
        required: isRequired(node),
        ...(options && options.length ? { options } : {}),
      });
    }
    return out;
  } catch {
    return []; // never-silent-fail: any CDP error → [] so the caller falls to vision
  } finally {
    await cdp.detach().catch(() => {});
  }
}
