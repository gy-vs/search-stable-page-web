import {describe,expect,it} from 'vitest';
import {CursorInvalidError,SearchPager,type Page} from '../src/client/pager';

type Q={q:string};
type T={id:string};

function pagerWith(handler:(cursor:string|null,q:Q)=>Promise<Page<T>>){
  return new SearchPager<Q,T>(handler,{q:'init'});
}

describe('SearchPager',()=>{
  it('never uses the same cursor twice under rapid concurrent loadMore calls',async()=>{
    const calls:(string|null)[]=[];
    const pager=pagerWith(async cursor=>{
      calls.push(cursor);
      if(calls.length===1)return {items:[{id:'a'},{id:'b'}],nextCursor:'c1',hasMore:true,revision:0};
      return {items:[{id:'c'}],nextCursor:null,hasMore:false,revision:0};
    });
    // two rapid clicks before the first request settles
    await Promise.all([pager.loadMore(),pager.loadMore(),pager.loadMore()]);
    expect(calls).toEqual([null]);
    expect(pager.getSnapshot().items.map(i=>i.id)).toEqual(['a','b']);
    // after settling, the next click uses the cursor exactly once
    await pager.loadMore();
    expect(calls).toEqual([null,'c1']);
    expect(pager.getSnapshot().items.map(i=>i.id)).toEqual(['a','b','c']);
    expect(pager.getSnapshot().hasMore).toBe(false);
    // exhausted: further clicks are no-ops
    await pager.loadMore();
    expect(calls).toHaveLength(2);
  });

  it('keeps loaded items on cursor invalidation and only recovers via restart',async()=>{
    let mode:'ok'|'stale'|'fresh'='ok';
    const pager=pagerWith(async()=>{
      if(mode==='ok')return {items:[{id:'a'},{id:'b'}],nextCursor:'c1',hasMore:true,revision:1};
      if(mode==='stale')throw new CursorInvalidError('revision_mismatch',2);
      return {items:[{id:'x'},{id:'y'}],nextCursor:null,hasMore:false,revision:2};
    });
    await pager.loadMore();
    mode='stale';
    await pager.loadMore();
    const state=pager.getSnapshot();
    expect(state.invalidated).toEqual({reason:'revision_mismatch',currentRevision:2});
    expect(state.items.map(i=>i.id)).toEqual(['a','b']); // old results preserved, not merged
    // blocked while invalidated: no implicit retry, no auto-merge
    await pager.loadMore();
    expect(pager.getSnapshot().items.map(i=>i.id)).toEqual(['a','b']);
    // user-driven refresh restarts from scratch
    mode='fresh';
    await pager.restart({q:'init'});
    expect(pager.getSnapshot().items.map(i=>i.id)).toEqual(['x','y']);
    expect(pager.getSnapshot().invalidated).toBeNull();
    expect(pager.getSnapshot().revision).toBe(2);
  });

  it('dedupes overlapping pages by id (defense in depth)',async()=>{
    const pages:Page<T>[]=[
      {items:[{id:'a'},{id:'b'}],nextCursor:'c1',hasMore:true,revision:0},
      {items:[{id:'b'},{id:'c'}],nextCursor:null,hasMore:false,revision:0}, // 'b' repeated
    ];
    let i=0;
    const pager=pagerWith(async()=>pages[i++]);
    await pager.loadMore();
    await pager.loadMore();
    expect(pager.getSnapshot().items.map(x=>x.id)).toEqual(['a','b','c']);
  });

  it('handles an empty first page',async()=>{
    const pager=pagerWith(async()=>({items:[],nextCursor:null,hasMore:false,revision:0}));
    await pager.loadMore();
    expect(pager.getSnapshot().items).toEqual([]);
    expect(pager.getSnapshot().hasMore).toBe(false);
    await pager.loadMore(); // no-op, no crash
  });

  it('rethrows non-cursor errors and clears the loading flag',async()=>{
    const pager=pagerWith(async()=>{throw new Error('network down')});
    await expect(pager.loadMore()).rejects.toThrow('network down');
    expect(pager.getSnapshot().loading).toBe(false);
    expect(pager.getSnapshot().invalidated).toBeNull();
  });
});
