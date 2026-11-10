// BSD script requires its own stdin to be a terminal. The standard-library PTY
// bridge also works when the native monitor has pipes for stdin/stdout. It only
// forwards bytes; trust decisions remain in the exact-prompt handler.
export const macTerminalBridge=String.raw`
import os,pty,select,signal,sys
pid,fd=pty.fork()
if pid==0:
 os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
def stop(signum,frame):
 try: os.killpg(pid,signal.SIGTERM)
 except ProcessLookupError: pass
signal.signal(signal.SIGTERM,stop)
inputs=[fd,0]
while fd in inputs:
 for src in select.select(inputs,[],[])[0]:
  try: data=os.read(src,65536)
  except OSError: data=b''
  if not data:
   inputs.remove(src)
   if src==0: stop(None,None)
   continue
  target=1 if src==fd else fd
  while data:
   written=os.write(target,data)
   data=data[written:]
_,status=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
