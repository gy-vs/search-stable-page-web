import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {AlertTriangle,ArrowDownWideNarrow,ArrowUpNarrowWide,Plus,RefreshCw,Search,Trash2} from 'lucide-react';
import {CursorInvalidError,SearchPager,type Page} from './pager';

type Item={id:string;title:string;content:string;tags:string[];score:number};
type Query={q:string;tag:string;sortDir:'asc'|'desc'};

async function fetchPage(cursor:string|null,query:Query):Promise<Page<Item>>{
  const params=new URLSearchParams({q:query.q,sortDir:query.sortDir,pageSize:'10'});
  if(query.tag)params.set('tag',query.tag);
  if(cursor)params.set('cursor',cursor);
  const response=await fetch('/api/search?'+params);
  const body=await response.json();
  if(!response.ok){
    if(body?.error?.code==='invalid_cursor')throw new CursorInvalidError(body.error.reason,body.error.currentRevision);
    throw new Error('search failed: '+response.status);
  }
  return body;
}

const INVALID_REASONS:Record<string,string>={
  revision_mismatch:'索引已更新（revision 变化）',
  fingerprint_mismatch:'查询/筛选/排序配置已变化',
  malformed:'游标格式非法',
  bad_signature:'游标被篡改',
};

export default function App(){
  const pagerRef=useRef<SearchPager<Query,Item>|null>(null);
  if(!pagerRef.current)pagerRef.current=new SearchPager<Query,Item>(fetchPage,{q:'',tag:'',sortDir:'desc'});
  const pager=pagerRef.current;
  const state=useSyncExternalStore(pager.subscribe,pager.getSnapshot);

  const [q,setQ]=useState('');
  const [tag,setTag]=useState('');
  const [sortDir,setSortDir]=useState<'asc'|'desc'>('desc');
  const [newId,setNewId]=useState('');
  const [indexRev,setIndexRev]=useState<number|null>(null);
  const [notice,setNotice]=useState('');

  useEffect(()=>{void pager.restart({q:'',tag:'',sortDir:'desc'})},[pager]);

  function search(){void pager.restart({q,tag,sortDir})}

  async function mutateIndex(fn:()=>Promise<Response>){
    const response=await fn();
    const body=await response.json();
    if(response.ok){
      setIndexRev(body.revision);
      setNotice(`索引已变更，revision=${body.revision}。继续翻页将收到失效提示，需刷新后重新检索。`);
    }else setNotice('操作失败: '+(body.error??response.status));
  }
  const addDoc=()=>mutateIndex(()=>fetch('/api/docs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:newId||`doc-${Date.now()}`,title:q||'new doc',content:q||'new',tags:tag?[tag]:[]})}));
  const removeDoc=(id:string)=>mutateIndex(()=>fetch('/api/docs/'+encodeURIComponent(id),{method:'DELETE'}));

  return <main className="shell">
    <header className="topbar"><Search size={20}/><strong>Search Relevance Lab</strong><small>稳定游标分页工作台</small>
      <span className="rev">结果 revision: {state.revision??'—'} · 索引 revision: {indexRev??'—'}</span>
    </header>
    <section className="workspace">
      <aside className="pane">
        <h2>检索配置</h2>
        <label className="field">查询词<input aria-label="查询词" value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search()}/></label>
        <label className="field">标签筛选<select aria-label="标签筛选" value={tag} onChange={e=>setTag(e.target.value)}><option value="">全部</option><option value="even">even</option><option value="odd">odd</option><option value="tri">tri</option><option value="plain">plain</option></select></label>
        <button className="tool" onClick={()=>{const next=sortDir==='desc'?'asc':'desc';setSortDir(next)}}>{sortDir==='desc'?<ArrowDownWideNarrow size={15}/>:<ArrowUpNarrowWide size={15}/>}分数{sortDir==='desc'?'降序':'升序'}（切换）</button>
        <button className="tool primary" onClick={search}><Search size={15}/>重新检索</button>
        <h2>模拟索引变更</h2>
        <label className="field">新文档 id<input aria-label="新文档 id" value={newId} onChange={e=>setNewId(e.target.value)} placeholder="留空自动生成"/></label>
        <button className="tool" onClick={addDoc}><Plus size={15}/>新增文档</button>
        <p className="hint">新增或删除文档会推进索引 revision，使未完成的游标失效。</p>
        {notice&&<p className="notice">{notice}</p>}
      </aside>
      <section className="pane">
        {state.invalidated&&<div className="banner" role="alert">
          <AlertTriangle size={16}/>
          <span>结果已失效（{INVALID_REASONS[state.invalidated.reason]??state.invalidated.reason}）。已保留当前 {state.items.length} 条结果，未自动合并新版本数据。</span>
          <button className="tool primary" onClick={search}><RefreshCw size={14}/>刷新重检</button>
        </div>}
        <ol className="results">
          {state.items.map(item=><li key={item.id} className="result">
            <span className="score">{item.score}</span>
            <span className="doc"><strong>{item.id}</strong> {item.title}<br/><small>{item.tags.join(', ')}</small></span>
            <button className="icon" aria-label={`删除 ${item.id}`} onClick={()=>removeDoc(item.id)}><Trash2 size={14}/></button>
          </li>)}
        </ol>
        {state.items.length===0&&!state.loading&&<p className="hint">无结果（空页）。</p>}
        <div className="toolbar">
          <button className="tool" disabled={state.loading||!state.hasMore||!!state.invalidated} onClick={()=>void pager.loadMore()}>
            {state.loading?'加载中…':state.hasMore?'加载更多':'没有更多了'}
          </button>
          <span className="hint">已加载 {state.items.length} 条</span>
        </div>
      </section>
    </section>
  </main>;
}
