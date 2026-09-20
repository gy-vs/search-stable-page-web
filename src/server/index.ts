import express from 'express';
import {fileURLToPath} from 'node:url';
import {createHmac} from 'node:crypto';
import {SearchIndex, seedDocs, type Doc, type SearchQuery, type SortDirection} from './searchIndex';
import {CURSOR_VERSION, decodeCursor, encodeCursor, queryFingerprint, type CursorRejection} from './cursor';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary query judgments',revision:3,content:'query judgments: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary query judgments',revision:5,content:'query judgments: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

// Secret for signing cursors. Derived per-process so restarts invalidate
// outstanding cursors (they fail closed with bad_signature).
const CURSOR_SECRET = process.env.CURSOR_SECRET ?? createHmac('sha256', 'search-cursor').update(String(process.pid)+Date.now()).digest('hex');

export type AppOptions = {index?: SearchIndex; cursorSecret?: string};

export function createApp(options: AppOptions = {}){
  const index = options.index ?? new SearchIndex(seedDocs());
  const secret = options.cursorSecret ?? CURSOR_SECRET;
  const app=express();
  app.use(express.json({limit:'1mb'}));

  app.get('/api/bootstrap',(_req,res)=>res.json({family:"search-relevance",count:rows.length}));
  app.get('/api/experiments',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/experiments/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/experiments/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/experiments/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  const rejectCursor=(res:express.Response,reason:CursorRejection)=>{
    res.status(409).json({error:{code:'invalid_cursor',reason,restartable:true,currentRevision:index.revision}});
  };

  // Keyset-paginated search. The cursor encodes the full sort key, the
  // query fingerprint and the index revision; any mismatch is rejected
  // with a structured, restartable reason instead of silently paging
  // against a different result set.
  app.get('/api/search',(req,res)=>{
    const query:SearchQuery={
      q:String(req.query.q??''),
      tag:req.query.tag?String(req.query.tag):null,
      sortDir:(req.query.sortDir==='asc'?'asc':'desc') as SortDirection,
    };
    const parsed=Number.parseInt(String(req.query.pageSize??'10'),10);
    const pageSize=Number.isFinite(parsed)?Math.min(Math.max(parsed,1),100):10;
    const fp=queryFingerprint(query);
    let afterKey:[number,string]|null=null;
    if(req.query.cursor!=null){
      const decoded=decodeCursor(String(req.query.cursor),secret);
      if(!decoded.ok)return rejectCursor(res,decoded.reason);
      const cursor=decoded.payload;
      if(cursor.rev!==index.revision)return rejectCursor(res,'revision_mismatch');
      if(cursor.fp!==fp)return rejectCursor(res,'fingerprint_mismatch');
      afterKey=cursor.key;
    }
    const found=index.search(query,afterKey,pageSize+1);
    const hasMore=found.length>pageSize;
    const items=hasMore?found.slice(0,pageSize):found;
    const last=items[items.length-1];
    const nextCursor=hasMore&&last?encodeCursor({v:CURSOR_VERSION,rev:index.revision,fp,key:[last.score,last.id]},secret):null;
    res.json({items,nextCursor,hasMore,revision:index.revision});
  });

  // Index mutations. Each one bumps the index revision, which is what
  // invalidates outstanding cursors (revision_mismatch on next use).
  app.post('/api/docs',(req,res)=>{
    const doc:Doc={id:String(req.body.id??''),title:String(req.body.title??''),content:String(req.body.content??''),tags:Array.isArray(req.body.tags)?req.body.tags.map(String):[]};
    if(!doc.id)return res.status(400).json({error:'id_required'});
    if(index.has(doc.id))return res.status(409).json({error:'duplicate_id'});
    index.insert(doc);
    res.status(201).json({id:doc.id,revision:index.revision});
  });
  app.delete('/api/docs/:id',(req,res)=>{
    if(!index.remove(req.params.id))return res.status(404).json({error:'not_found'});
    res.json({id:req.params.id,revision:index.revision});
  });
  app.get('/api/index/status',(_req,res)=>res.json({revision:index.revision,size:index.size}));
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
