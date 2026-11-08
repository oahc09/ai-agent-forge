/** Fixed, credential-free offline fixture. Never accepts source code or commands. */
const mode=process.argv[2];
if(mode!=='success'&&mode!=='approval'&&mode!=='failure'&&mode!=='hang')process.exit(2);
process.on('disconnect',()=>process.exit(0));
process.on('SIGTERM',()=>process.exit(0));
process.send?.({type:'ready',pid:process.pid});
if(mode==='approval')setTimeout(()=>process.send?.({type:'approval',reason:'Offline fixture approval'}),20);
if(mode==='success')setTimeout(()=>process.exit(0),30);
if(mode==='failure')setTimeout(()=>process.exit(1),30);
setInterval(()=>{},1000);
