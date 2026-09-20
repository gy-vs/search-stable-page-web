import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {SearchIndex,compareKeys,type Doc} from '../src/server/searchIndex';

const SECRET='test-secret';

function makeDocs(count:number,content:(i:number)=>string):Doc[]{
  return Array.from({length:count},(_,i)=>({
    id:`doc-${String(i+1).padStart(3,'0')}`,
    title:`title ${i+1}`,
    content:content(i+1),
    tags:[i%2===0?'even':'odd'],
  }));
}

function setup(docs:Doc[]){
  const index=new SearchIndex(docs);
  return {index,app:createApp({index,cursorSecret:SECRET})};
}

async function collectAll(app:ReturnType<typeof createApp>,params:Record<string,string>){
  const items:{id:string;score:number}[]=[];
  let cursor:string|null=null;
  const seen=new Set<string>();
  for(;;){
    const query:Record<string,string>={...params,...(cursor?{cursor}:{})};
    const res:request.Response=await request(app).get('/api/search').query(query).expect(200);
    for(const item of res.body.items){
      expect(seen.has(item.id)).toBe(false); // no duplicates across pages
      seen.add(item.id);
      items.push(item);
    }
    if(!res.body.hasMore){
      expect(res.body.nextCursor).toBeNull();
      return {items,revision:res.body.revision};
    }
    expect(typeof res.body.nextCursor).toBe('string');
    cursor=res.body.nextCursor;
  }
}

describe('stable keyset pagination',()=>{
  it('pages a heavily tied result set exactly once per document',async()=>{
    // 53 docs, ALL with the same score for q=tie -> order decided purely by id tie-break.
    const {app}=setup(makeDocs(53,()=>'tie'));
    const {items,revision}=await collectAll(app,{q:'tie',pageSize:'10'});
    expect(items).toHaveLength(53);
    expect(items.map(i=>i.id)).toEqual([...items.map(i=>i.id)].sort());
    expect(revision).toBe(0);
  });

  it('orders mixed scores deterministically and matches the comparator',async()=>{
    // scores 1..5 repeating, many ties per score bucket
    const docs=makeDocs(40,i=>'x '.repeat((i%5)+1).trim());
    const {app}=setup(docs);
    const {items}=await collectAll(app,{q:'x',pageSize:'7',sortDir:'desc'});
    expect(items).toHaveLength(40);
    const sorted=[...items].sort((a,b)=>compareKeys(a,b,'desc'));
    expect(items.map(i=>i.id)).toEqual(sorted.map(i=>i.id));
    // scores non-increasing
    for(let i=1;i<items.length;i++)expect(items[i-1].score).toBeGreaterThanOrEqual(items[i].score);
  });

  it('supports ascending direction with exactly-once delivery',async()=>{
    const docs=makeDocs(25,i=>'x '.repeat((i%3)+1).trim());
    const {app}=setup(docs);
    const {items}=await collectAll(app,{q:'x',pageSize:'10',sortDir:'asc'});
    expect(items).toHaveLength(25);
    const sorted=[...items].sort((a,b)=>compareKeys(a,b,'asc'));
    expect(items.map(i=>i.id)).toEqual(sorted.map(i=>i.id));
    for(let i=1;i<items.length;i++)expect(items[i-1].score).toBeLessThanOrEqual(items[i].score);
  });

  it('rejects a cursor after a document is deleted (revision_mismatch, restartable)',async()=>{
    const {app}=setup(makeDocs(20,()=>'tie'));
    const page1=await request(app).get('/api/search').query({q:'tie',pageSize:'10'}).expect(200);
    await request(app).delete('/api/docs/doc-001').expect(200);
    const res=await request(app).get('/api/search').query({q:'tie',pageSize:'10',cursor:page1.body.nextCursor}).expect(409);
    expect(res.body.error).toMatchObject({code:'invalid_cursor',reason:'revision_mismatch',restartable:true,currentRevision:1});
    // restart from scratch on the new revision: exactly-once, deleted doc gone
    const {items,revision}=await collectAll(app,{q:'tie',pageSize:'10'});
    expect(items).toHaveLength(19);
    expect(items.some(i=>i.id==='doc-001')).toBe(false);
    expect(revision).toBe(1);
  });

  it('rejects a cursor after a document is inserted, then serves it on restart',async()=>{
    const {app}=setup(makeDocs(15,()=>'tie'));
    const page1=await request(app).get('/api/search').query({q:'tie',pageSize:'10'}).expect(200);
    await request(app).post('/api/docs').send({id:'doc-100',title:'new',content:'tie',tags:['even']}).expect(201);
    const res=await request(app).get('/api/search').query({q:'tie',pageSize:'10',cursor:page1.body.nextCursor}).expect(409);
    expect(res.body.error.reason).toBe('revision_mismatch');
    const {items}=await collectAll(app,{q:'tie',pageSize:'10'});
    expect(items).toHaveLength(16);
    expect(items.some(i=>i.id==='doc-100')).toBe(true);
  });

  it('rejects a cursor when sort direction is switched (fingerprint_mismatch)',async()=>{
    const {app}=setup(makeDocs(20,i=>'x '.repeat(i%4).trim()));
    const page1=await request(app).get('/api/search').query({q:'x',pageSize:'10',sortDir:'desc'}).expect(200);
    const res=await request(app).get('/api/search').query({q:'x',pageSize:'10',sortDir:'asc',cursor:page1.body.nextCursor}).expect(409);
    expect(res.body.error).toMatchObject({code:'invalid_cursor',reason:'fingerprint_mismatch',restartable:true});
  });

  it('rejects a cursor when the filter or query text changes (fingerprint_mismatch)',async()=>{
    const {app}=setup(makeDocs(20,()=>'tie'));
    const page1=await request(app).get('/api/search').query({q:'tie',tag:'even',pageSize:'5'}).expect(200);
    const byTag=await request(app).get('/api/search').query({q:'tie',tag:'odd',pageSize:'5',cursor:page1.body.nextCursor}).expect(409);
    expect(byTag.body.error.reason).toBe('fingerprint_mismatch');
    const byQuery=await request(app).get('/api/search').query({q:'other',tag:'even',pageSize:'5',cursor:page1.body.nextCursor}).expect(409);
    expect(byQuery.body.error.reason).toBe('fingerprint_mismatch');
    // same config, different pageSize is fine: pageSize is not part of the fingerprint
    await request(app).get('/api/search').query({q:'tie',tag:'even',pageSize:'8',cursor:page1.body.nextCursor}).expect(200);
  });

  it('rejects tampered and malformed cursors',async()=>{
    const {app}=setup(makeDocs(20,()=>'tie'));
    const page1=await request(app).get('/api/search').query({q:'tie',pageSize:'10'}).expect(200);
    const cursor=page1.body.nextCursor as string;

    // flipped character in the signature
    const flipped=cursor.slice(0,-1)+(cursor.endsWith('A')?'B':'A');
    expect((await request(app).get('/api/search').query({q:'tie',cursor:flipped}).expect(409)).body.error.reason).toBe('bad_signature');

    // payload edited (revision bumped) but old signature reused
    const [body,sig]=cursor.split('.');
    const payload=JSON.parse(Buffer.from(body,'base64url').toString());
    payload.rev+=1;
    const forged=Buffer.from(JSON.stringify(payload)).toString('base64url')+'.'+sig;
    expect((await request(app).get('/api/search').query({q:'tie',cursor:forged}).expect(409)).body.error.reason).toBe('bad_signature');

    // not a cursor at all
    expect((await request(app).get('/api/search').query({q:'tie',cursor:'garbage'}).expect(409)).body.error.reason).toBe('malformed');
  });

  it('handles empty pages: no matches and exact-boundary final page',async()=>{
    const {app}=setup(makeDocs(20,()=>'tie'));
    const none=await request(app).get('/api/search').query({q:'no-such-term'}).expect(200);
    expect(none.body).toMatchObject({items:[],hasMore:false,nextCursor:null});

    // 20 docs, pageSize 20 -> single page ending exactly at the boundary
    const exact=await request(app).get('/api/search').query({q:'tie',pageSize:'20'}).expect(200);
    expect(exact.body.items).toHaveLength(20);
    expect(exact.body.hasMore).toBe(false);
    expect(exact.body.nextCursor).toBeNull();

    // empty query: everything scores 0 (maximal ties), still exactly-once
    const {items}=await collectAll(app,{q:'',pageSize:'6'});
    expect(items).toHaveLength(20);
  });
});
