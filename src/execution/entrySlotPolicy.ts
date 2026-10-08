export type EntrySource = 'DEX' | 'SENTINEL';
interface SlotPosition { mint: string; entrySource?: EntrySource; }
/** Atomic in-process reservations cover asynchronous audits and submissions. */
export class EntrySlotPolicy {
  private readonly pending = new Map<string, EntrySource>();
  public count(source: EntrySource, positions: SlotPosition[]): number {
    const mints=new Set(positions.filter(p=>(p.entrySource ?? 'DEX')===source).map(p=>p.mint));
    for(const [mint, origin] of this.pending) if(origin===source) mints.add(mint);
    return mints.size;
  }
  public reserve(mint:string, source:EntrySource, positions:SlotPosition[]):boolean {
    if(this.pending.has(mint)||positions.some(p=>p.mint===mint)||this.count(source,positions)>=2) return false;
    this.pending.set(mint,source);return true;
  }
  public release(mint:string):void {this.pending.delete(mint);}
  public unfilledReservations(positions:SlotPosition[],excludeMint?:string):string[] {
    return [...this.pending.keys()].filter(mint=>mint!==excludeMint&&!positions.some(p=>p.mint===mint));
  }
}
