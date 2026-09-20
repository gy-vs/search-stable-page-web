import express from 'express';
import {fileURLToPath} from 'node:url';
import {SearchIndex, type SearchDoc} from './documents';
import {executeSearch} from './search';
import type {DocState} from '../shared/search';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary query judgments',revision:3,content:'query judgments: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary query judgments',revision:5,content:'query judgments: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

const STATES: ReadonlySet<string> = new Set(['active','review','archived']);

export function createApp(){
  const app=express();
  // 每个 app 实例持有独立索引，测试互不影响；revision 随增删单调递增。
  const index=new SearchIndex();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"search-relevance",count:rows.length,searchRevision:index.revision}));
  app.get('/api/experiments',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/experiments/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/experiments/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/experiments/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // ---- 搜索工作台：稳定键 (score,id) keyset 分页，游标内含指纹与 revision ----
  app.get('/api/search',(req,res)=>{
    const outcome=executeSearch({
      index,
      raw:{q:req.query.q,state:req.query.state,sort:req.query.sort,pageSize:req.query.pageSize,cursor:req.query.cursor},
    });
    if(!outcome.ok)return res.status(outcome.status).json(outcome);
    res.json(outcome);
  });

  app.get('/api/search/state',(_req,res)=>res.json({revision:index.revision,count:index.all().length}));

  app.post('/api/search/docs',(req,res)=>{
    const body=req.body??{};
    const doc: Partial<SearchDoc>={
      id: typeof body.id==='string'?body.id.trim():'',
      title: typeof body.title==='string'?body.title:'',
      state: body.state as DocState,
      score: Number(body.score),
    };
    if(!doc.id||!/^[a-z0-9-_]+$/i.test(doc.id))return res.status(400).json({error:'invalid_id'});
    if(!doc.title)return res.status(400).json({error:'invalid_title'});
    if(!STATES.has(doc.state as string))return res.status(400).json({error:'invalid_state'});
    if(!Number.isFinite(doc.score))return res.status(400).json({error:'invalid_score'});
    if(!index.add(doc as SearchDoc))return res.status(409).json({error:'duplicate_id'});
    res.status(201).json({revision:index.revision,doc:index.get(doc.id)});
  });

  app.delete('/api/search/docs/:id',(req,res)=>{
    if(!index.delete(req.params.id))return res.status(404).json({error:'not_found'});
    res.json({revision:index.revision});
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
