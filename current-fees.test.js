 'use strict';
const assert=require('node:assert/strict');
const cfg=require('./fee-config.json'),core=require('./series-fee'),{walk,american}=require('./noboost/pm-live'),{isPolyComboTicker}=require('./poly-combo-classifier');
assert.equal(cfg.polymarketUsTakerCoefficient,.095);assert.equal(require('./mm-paper-config').POLY_MAKER_REBATE,0);
assert.equal(american(.5+.095*.25),-110);assert.equal(walk([[.5,100]],'novig',100,{is_live:true}).depthUsd,48.5);assert.equal(walk([[.5,100]],'novig',100,{is_live:false}).depthUsd,50);
assert.equal(core.takerRateFromSeries('quadratic',.5,'KXMLBGAME'),.035);assert.equal(core.takerRateFromSeries(null,null,'KXMLBHR-X'),.035);
for(const t of ['caoc-X','crossd-X',' CROSSD-X '])assert.equal(isPolyComboTicker(t),true);assert.equal(isPolyComboTicker('aec-nfl-X'),false);
const uq=require('./unhedged-quote');assert.equal(uq.kalshiMakerRate('KXMVECROSSCATEGORY0-X'),0);assert.equal(uq.kalshiMakerRate('KXMVECROSSCATEGORY-X'),.035);assert.equal(uq.kalshiMakerRate([{league:'nfl'}]),.035);
(async()=>{let now=0,fail=false;const logs=[];const c=core.createSeriesFeeCache({now:()=>now,log:m=>logs.push(m),fetchImpl:async()=>{if(fail)throw Error('offline');return {ok:true,json:async()=>({series:{fee_type:'quadratic',fee_multiplier:.25}})};}});await c.prefetch('KXTEST');assert.equal(c.rateForTicker('KXTEST-X'),0);assert.equal(c.takerRateForTicker('KXTEST-X'),.0175);now=core.TTL_MS+1;fail=true;await c.prefetch('KXTEST');assert.equal(c.rateForTicker('KXTEST-X'),.035);assert.ok(logs.some(l=>l.includes('fallback')));assert.equal(c.rateForTicker('KXMVECROSSCATEGORY0-X'),0);console.log('current-fees: Tier1 +100→-110; live Novig +100→-106; bounded cache and series exemption OK');})().catch(e=>{console.error(e);process.exitCode=1;});

assert.equal(require('./poly-desk-fills').isComboSlug('crossd-X'),true);
assert.equal(require('./polymarket-fill-reconcile').isComboActivitySlug('crossd-X'),true);
