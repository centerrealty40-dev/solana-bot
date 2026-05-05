/** Disjoint-set для мета-кластеров (итеративный find — без переполнения стека на длинных цепочках). */
export class UnionFind {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    let cur = x;
    const path: string[] = [];
    while (true) {
      let p = this.parent.get(cur);
      if (p === undefined) {
        this.parent.set(cur, cur);
        p = cur;
      }
      if (p === cur) break;
      path.push(cur);
      cur = p;
    }
    const root = cur;
    for (const n of path) {
      this.parent.set(n, root);
    }
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
