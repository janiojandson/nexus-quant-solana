export type EntrySource = 'DEX' | 'SENTINEL';
interface SlotPosition { mint: string; entrySource?: EntrySource; isSentinelHandoff?: boolean; }
export interface EntrySlotSnapshot {total:number;active:number;dex:{active:number;max:number};sentinel:{active:number;max:number};}
/** Atomic in-process reservations cover asynchronous audits and submissions. */
export class EntrySlotPolicy {
  public static readonly MAX_PER_SOURCE = 2;
  public static readonly TOTAL = 4;
  public snapshot(positions: SlotPosition[]): EntrySlotSnapshot {
    const unique = [...new Map(positions.map(p=>[p.mint,p])).values()];
    const sentinel=unique.filter(p=>p.entrySource==='SENTINEL' || (!p.entrySource && p.isSentinelHandoff)).length;
    return {total:EntrySlotPolicy.TOTAL,active:unique.length,dex:{active:unique.length-sentinel,max:EntrySlotPolicy.MAX_PER_SOURCE},sentinel:{active:sentinel,max:EntrySlotPolicy.MAX_PER_SOURCE}};
  }
  private readonly pending = new Map<string, EntrySource>();
  public count(source: EntrySource, positions: SlotPosition[]): number {
    const mints=new Set(positions.filter(p=>(p.entrySource ?? 'DEX')===source).map(p=>p.mint));
    for(const [mint, origin] of this.pending) if(origin===source) mints.add(mint);
    return mints.size;
  }
  public reserve(mint:string, source:EntrySource, positions:SlotPosition[]):boolean {
    if(this.pending.has(mint)||positions.some(p=>p.mint===mint)||this.count(source,positions)>=EntrySlotPolicy.MAX_PER_SOURCE) return false;
    this.pending.set(mint,source);return true;
  }
  public release(mint:string):void {this.pending.delete(mint);}
  public unfilledReservations(positions:SlotPosition[],excludeMint?:string):string[] {
    return [...this.pending.keys()].filter(mint=>mint!==excludeMint&&!positions.some(p=>p.mint===mint));
  }
}
