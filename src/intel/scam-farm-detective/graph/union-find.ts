/** Disjoint-set для мета-кластеров по рёбрам кошелёк↔кошелёк. */
export class UnionFind {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    const root = this.find(p);
    if (root !== p) this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  /** Корень → множество узлов компоненты. */
  components(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const node of this.parent.keys()) {
      const r = this.find(node);
      let set = out.get(r);
      if (!set) {
        set = new Set<string>();
        out.set(r, set);
      }
      set.add(node);
    }
    return out;
  }
}
