import test from 'node:test';import assert from 'node:assert/strict';
import {MessageSnapshots} from '../ui/conversation/message-snapshots.mjs';
const sent={id:'sent',requestId:'request',number:2,body:'new message'};
const old={channel:{id:'one'},messages:[{id:'first',number:1,body:'old message'}]};
test('send receipts survive older refreshes and are released only when the server catches up',()=>{
 const cache=new MessageSnapshots();cache.apply('one',old,cache.beginRead('one'));const late=cache.beginRead('one');cache.append('one',sent);
 assert.equal(cache.apply('one',old,late).messages.at(-1).id,'sent');
 assert.equal(cache.apply('one',{...old,messages:[...old.messages,sent]},cache.beginRead('one')).messages.length,2);
 assert.equal(cache.receipts.get('one').size,0);
 const edited={...sent,body:'edited on server'};assert.equal(cache.apply('one',{...old,messages:[edited]},cache.beginRead('one')).messages[0].body,edited.body);
});
test('overlapping reads cannot roll back a newer snapshot, including cached inactive chats',()=>{
 const cache=new MessageSnapshots(),first=cache.beginRead('one');cache.append('one',sent);const second=cache.beginRead('one');
 cache.apply('one',{...old,messages:[sent]},second);assert.equal(cache.apply('one',old,first),null);assert.equal(cache.get('one').messages[0].id,'sent');
 cache.apply('two',{messages:[]},cache.beginRead('two'));assert.equal(cache.get('two').messages.length,0);
});
test('an acknowledged message outside the latest server page is not kept forever',()=>{
 const cache=new MessageSnapshots();cache.append('one',sent);const next=cache.apply('one',{messages:[{id:'later',number:3}]},cache.beginRead('one'));
 assert.deepEqual(next.messages.map(m=>m.id),['later']);assert.equal(cache.receipts.get('one').size,0);
});

test('slow materials can finish after a fast chat update without erasing either projection',()=>{
 const cache=new MessageSnapshots(),full=cache.beginRead('one'),fast=cache.beginRead('one');
 cache.apply('one',{...old,messages:[sent],activity:[{id:'turn',status:'active'}]},fast);
 const merged=cache.apply('one',{...old,activity:[],documents:[{id:'doc',version:3}],meetings:[]},full);
 assert.equal(merged.messages[0].id,'sent');assert.equal(merged.activity[0].status,'active');assert.equal(merged.documents[0].version,3);
 assert.equal(cache.apply('one',{messages:[sent],activity:[{id:'turn',status:'done'}]},cache.beginRead('one')).documents[0].id,'doc');
});

test('unread availability requires the actual chat cache, including inactive and empty hidden-message pages',()=>{
 const cache=new MessageSnapshots();assert.equal(cache.covers('one',2),false);
 cache.apply('one',old,cache.beginRead('one'));assert.equal(cache.covers('one',2),false);
 cache.apply('one',{...old,messages:[sent]},cache.beginRead('one'));assert.equal(cache.covers('one',2),true);
 assert.equal(cache.covers('another',2),false);
 cache.apply('hidden',{channel:{id:'hidden',messageSequence:3},messages:[]},cache.beginRead('hidden'));assert.equal(cache.covers('hidden',3),true);
});
