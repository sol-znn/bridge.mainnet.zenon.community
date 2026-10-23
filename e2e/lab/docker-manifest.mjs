// Runtime image pairing for the isolated Docker lab; no wallet or host exports.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { here, digest, verifiedBuild } from './verify-build.mjs'
const build = verifiedBuild('docker')
const run = (args) => execFileSync('docker', args).toString().trim()
const roles = ['pillar','pillar2','pillar3','observer','rpc']
const images = Object.fromEntries(roles.map((role) => [role, run(['inspect','--format','{{.Image}}',`bridge-lab-${role}`])]))
if (Object.values(images).some((id) => id !== build.imageId)) throw new Error('A running lab node differs from the built Docker image')
const anvilImageId = run(['image','inspect','--format','{{.Id}}',build.pins.anvilImage])
if (run(['inspect','--format','{{.Image}}','bridge-lab-anvil']) !== anvilImageId) throw new Error('The running Anvil image differs from its pin')
const git = (args) => execFileSync('git',args).toString().trim()
const assets = path.join(here,'assets'), directory = path.join(here,'.build/docker')
fs.mkdirSync(directory,{recursive:true})
fs.writeFileSync(path.join(directory,'run-manifest.json'),JSON.stringify({
  mode:'docker', sourceCommit:git(['rev-parse','HEAD']),sourceTree:git(['rev-parse','HEAD^{tree}']),sourceDirty:git(['status','--porcelain']).length>0,
  goSourceCommit:build.sourceCommit,goSourceTree:build.sourceTree,buildKey:build.key,
  znndImageId:build.imageId,nodeImageIds:images,anvilImagePin:build.pins.anvilImage,anvilImageId,
  genesisHash:digest(fs.readFileSync(path.join(assets,'genesis.json'))),
  configInputHashes:Object.fromEntries(roles.map((role)=>[role,digest(fs.readFileSync(path.join(assets,role,'config.json')))])),
  chainIds:build.pins.chainIds,startedAt:new Date().toISOString(),
},null,2)+'\n')
