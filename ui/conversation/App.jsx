import {SharedFiles,UploadFiles,FileCard,FileDialog,HandoffCard,HandoffDialog} from './SharedSpace.jsx';
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  Suspense,
  lazy,
} from "react";
import {
  Layers,
  Hash,
  Plus,
  MessageSquare,
  Users,
  FileText,
  ChevronDown,
  ArrowUp,
  AtSign,
  Reply,
  X,
  Settings2,
  Check,
  BookOpen,
  Columns3,
  Video,
  Clock,
  ArrowLeft,
  ExternalLink,
  Search,
  PanelRightClose,
  PanelRightOpen,
  MoreHorizontal,
  Copy,
  Download,
  History,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {DropdownMenu,DropdownMenuTrigger,DropdownMenuContent,DropdownMenuItem,DropdownMenuSeparator} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api, command, time } from "../v1/api.mjs";
import { startPolling } from "../v1/polling.mjs";
import { marked } from "marked";
import DOMPurify from "dompurify";
import BUILD from "../../shared/build-info.json";
import "./styles.css";
import ChatSessionPicker from './ChatSessionPicker.jsx';
import AgentAvatar from './AgentAvatar.jsx';
import MeetingPanel, { MeetingCard } from './MeetingPanel.jsx';
const ConnectWizard = lazy(() =>
  import("../v1/App.jsx").then((m) => ({ default: m.ConnectWizard })),
);
const statusText = {
  ready: "等待回应",
  active: "正在处理",
  done: "已回应",
  silent: "已读，暂无补充",
  merged: "已合并阅读",
  limited: "本轮连续回应已停止",
  unavailable: "自动接入未就绪",
  stalled: "尚未收到回应",
  removed: "已移出群",
};
const markdown = (body) => DOMPurify.sanitize(marked.parse(body || ""));
const Face=AgentAvatar;

function Modal({ title, description, children, error, onClose, sessionPicker=false }) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className={sessionPicker?'session-dialog sm:max-w-xl':'max-h-[85vh] overflow-auto sm:max-w-xl'}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}
function readSaved() {
  try {
    return JSON.parse(localStorage.getItem("hub-communication") || "{}");
  } catch {
    return {};
  }
}
export default function App() {
  const saved = useRef(readSaved()),
    [workspace, setWorkspace] = useState({
      members: [],
      connections: [],
      accounts: [],
    }),
    [channels, setChannels] = useState([]),
    [current, setCurrent] = useState(saved.current.channelId || ""),
    [snapshot, setSnapshot] = useState(null),
    [page, setPage] = useState(saved.current.page === "members" ? "members" : "chat"),
    [tab, setTab] = useState("documents"),
    [side, setSide] = useState(true),
    [modal, setModal] = useState(null),
    [error, setError] = useState(""),
    [syncError, setSyncError] = useState(""),
    [meetingPanel, setMeetingPanel] = useState(saved.current.meetingPanel || null),
    [meetingScopes,setMeetingScopes] = useState(saved.current.meetingScopes||{}),
    [olderMeetings,setOlderMeetings]=useState([]),[meetingCursor,setMeetingCursor]=useState(undefined),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [drafts, setDrafts] = useState(saved.current.drafts || {}),
    [reply, setReply] = useState(null),
    [mentions, setMentions] = useState([]),
    [showMentions, setShowMentions] = useState(false),
    [documentId, setDocumentId] = useState(null),
    [sharedFileId,setSharedFileId]=useState(null),[handoffId,setHandoffId]=useState(null),
    [query, setQuery] = useState(""),
    [older, setOlder] = useState([]),
    [moreCursor, setMoreCursor] = useState(null),
    [lastSync, setLastSync] = useState(null);
  const [codingStatus,setCodingStatus]=useState({members:[],approvals:[]});
  const currentRef = useRef(current),
    scroll = useRef(null),
    nearBottom = useRef(true),
    pendingSend = useRef(null),
    lastMessage = useRef("");
  currentRef.current = current;
  useEffect(()=>{let alive=true;const tick=()=>api('/local/coding/status').then(x=>{if(alive&&Array.isArray(x.members))setCodingStatus(x);}).catch(()=>{});tick();const timer=setInterval(tick,4000);return()=>{alive=false;clearInterval(timer);};},[]);
  const name = (id) =>
    id === 'system' ? '会议记录' : id === "owner"
      ? "我"
      : workspace.members.find((m) => m.id === id)?.name || workspace.formerMembers?.find(m=>m.id===id)?.name || "已移出成员";
  const refreshWorkspace = useCallback(async () => {
    const results = await Promise.allSettled([
      api("/v2/workspace"),
      api("/v2/channels"),
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    const [w, c] = results.map(result => result.value);
    setWorkspace(w);
    setChannels(c.items);
    if (!currentRef.current && c.items[0]) setCurrent(c.items[0].id);
  }, []);
  const refresh = useCallback(async () => {
    const id = currentRef.current;
    if (!id) return;
    const data = await api("/v2/channel?id=" + id);
    if (currentRef.current === id) {
      setSnapshot(data);
      setLastSync(new Date().toISOString());
      setMoreCursor((old) => (old === undefined ? data.before : old));
      setMeetingCursor(old=>old===undefined?data.meetingsCursor:old);
    }
  }, []);
  useEffect(() => {
    let alive = true;
    const stop = startPolling({
      run: async () => {
        await refreshWorkspace();
        if (alive) await refresh();
      },
      onSuccess: () => setSyncError(""),
      onError: e => setSyncError(e.message),
    });
    return () => {
      alive = false;
      stop();
    };
  }, [refreshWorkspace, refresh]);
  useEffect(() => {
    setSnapshot(null);
    setOlder([]);
    setOlderMeetings([]);setMeetingCursor(undefined);
    setMoreCursor(undefined);
    setReply(null);
    setMentions([]);
    setDocumentId(null);
    setShowMentions(false);
    lastMessage.current = "";
    nearBottom.current = true;
    refresh().then(() => setSyncError("")).catch((e) => setSyncError(e.message));
  }, [current, refresh]);
  useEffect(() => {
    localStorage.setItem(
      "hub-communication",
      JSON.stringify({ channelId: current, drafts, meetingPanel, meetingScopes,page: page === "members" ? "members" : "chat" }),
    );
  }, [current, drafts, page, meetingPanel,meetingScopes]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    const last = snapshot?.messages.at(-1)?.id;
    if (last && last !== lastMessage.current && nearBottom.current)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "smooth",
      });
    lastMessage.current = last;
  }, [snapshot]);
  const perform = async (fn) => {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      // A committed action remains successful even if the following read fails.
      await Promise.all([refreshWorkspace(), refresh()])
        .then(() => setSyncError(""))
        .catch(e => setSyncError(e.message));
      return result;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const act = (type, args = {}) =>
    perform(() => command(type, { channelId: current, ...args })).catch(
      () => {},
    );
  const openDirect = async (member) => {
    const directChannels = channels.filter(c => c.direct && c.memberIds.length === 1 && c.memberIds[0] === member.id);
    let dm = directChannels.find(c => c.status !== "archived") || directChannels[0];
    if (!dm) dm = await perform(() => command("channel.create", { name: member.name, memberIds: [member.id], coordinatorId: null, direct: true }));
    setCurrent(dm.id); setPage("chat"); setModal(null);
  };
  const channel = snapshot?.channel,
    activeMeetings=(snapshot?.meetings||[]).filter(m=>['running','closing'].includes(m.status)),
    scopedMeeting=Object.hasOwn(meetingScopes,current)?activeMeetings.find(m=>m.id===meetingScopes[current]):(activeMeetings.length===1?activeMeetings[0]:activeMeetings.find(m=>m.id===meetingPanel?.id)),
    groupMembers = workspace.members.filter((m) =>
      channel?.memberIds.includes(m.id),
    ),
    messages = [...older, ...(snapshot?.messages || [])]
      .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i)
      .sort((a, b) => a.number - b.number),
    draft = drafts[current] || "";
  async function send(e) {
    e?.preventDefault();
    if (!draft.trim() || busy || !channel) return;
    const targetMembers=groupMembers.filter(m=>!mentions.length||mentions.includes(m.id));
    const missing=targetMembers.find(m=>{if(!['codex','antigravity','gemini-cli','deepseek-harness','claude-code'].includes(m.platformId))return false;const r=codingStatus.members.find(r=>r.memberId===m.id);if(m.platformId==='claude-code')return !r?.assignments?.some(b=>b.channelId===current);return r?.enabled&&(r.manualAssignments||r.assignments?.length===0&&!r.sessionId&&r.sourceReady)&&!r.assignments?.some(b=>b.channelId===current);});
    if(missing){setModal({type:'session',member:missing});return;}
    const input = {
      channelId: current,
      body: draft,
      mentions,
      replyTo: reply?.id,
      ...(scopedMeeting?{meetingId:scopedMeeting.id}:{}),
    };
    const key = JSON.stringify(input);
    if (pendingSend.current?.key !== key)
      pendingSend.current = { key, requestId: crypto.randomUUID() };
    try {
      await perform(() =>
        api("/v2/commands", {
          type: "channel.post",
          requestId: pendingSend.current.requestId,
          ...input,
        }),
      );
      setDrafts((d) => ({ ...d, [current]: "" }));
      setReply(null);
      setMentions([]);
      pendingSend.current = null;
      nearBottom.current = true;
    } catch {}
  }
  async function loadOlder() {
    try {
      const data = await api(
        "/v2/channel?" +
          new URLSearchParams({ id: current, before: String(moreCursor) }),
      );
      setOlder((old) => [...data.messages, ...old]);
      setMoreCursor(data.before);
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <div className="communication" data-build-id={BUILD.id}>
      <aside className="comm-sidebar">
        <div className="comm-brand">
          <span>
            <Layers size={20} />
          </span>
          <strong>
            DuolaWork<small>一起沟通，一起完成</small>
          </strong>
        </div>
        <div className="comm-search">
          <Search size={15} />
          <input
            aria-label="搜索群聊"
            placeholder="搜索群聊"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          className={"nav-home " + (page === "members" ? "selected" : "")}
          onClick={() => setPage("members")}
        >
          <Users size={17} />
          成员与连接<span>{workspace.members.length}</span>
        </button>
        <div className="sidebar-caption">
          单聊与群聊
          <button
            aria-label="新建群聊"
            onClick={() => setModal({ type: "create" })}
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="channel-list">
          {channels
            .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
            .map((c) => (
              <button
                key={c.id}
                className={
                  page === "chat" && current === c.id ? "selected" : ""
                }
                onClick={() => {
                  setCurrent(c.id);
                  setPage("chat");
                }}
              >
                {c.direct ? <MessageSquare size={17} /> : <Hash size={17} />}
                <span>
                  {c.name}
                  <small>{c.lastMessage || "开始一段对话"}</small>
                </span>
              </button>
            ))}
          {!channels.length && (
            <p className="sidebar-empty">建个群，把你和 Agent 们放在一起。</p>
          )}
        </div>
        <button
          className="sidebar-new"
          onClick={() => setModal({ type: "create" })}
        >
          <Plus size={16} />
          新建群聊
        </button>
        <div className="sidebar-footer">
          <button onClick={() => setModal({ type: "history" })}>
            历史工作区 <ExternalLink size={12} />
          </button>
          <div>
            <i /> 本机工作区<span title={BUILD.id}>本地版</span>
          </div>
        </div>
      </aside>
      <main onDragOver={e=>{if(e.dataTransfer.types.includes("Files"))e.preventDefault();}} onDrop={e=>{if(e.dataTransfer.files.length&&current){e.preventDefault();window.dispatchEvent(new CustomEvent("duolawork-files",{detail:{channelId:current,files:[...e.dataTransfer.files]}}));}}} className="comm-main">
        {codingStatus.members.filter(m=>workspace.members.some(x=>x.id===m.memberId)&&(['needs_review','waiting_login'].includes(m.status)||codingStatus.approvals.some(a=>a.memberId===m.memberId))).map(m=><div className="comm-sync-status" role="status" key={m.memberId}>{name(m.memberId)}：{codingStatus.approvals.some(a=>a.memberId===m.memberId)?'有操作等待你确认':m.message}<Button size="sm" variant="outline" onClick={()=>{const member=workspace.members.find(x=>x.id===m.memberId);if(member)setModal({type:'connect',member});}}>查看</Button></div>)}
        {syncError && (
          <div className="comm-sync-status" role="status" aria-live="polite">
            {syncError} 正在恢复同步，连接恢复后此提示会自动消失。
          </div>
        )}
        {error && (
          <div className="comm-error" role="alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {notice && (
          <div className="comm-toast" role="status">
            <Check size={15} />
            {notice}
          </div>
        )}
        {page === "members" ? (
          <Members
            workspace={workspace}
            coding={codingStatus}
            refresh={refreshWorkspace}
            perform={perform}
            setModal={setModal}
            onChat={openDirect}
            name={name}
          />
        ) : !channel ? (
          <div className="comm-welcome">
            <div className="welcome-icon">
              <MessageSquare size={32} />
            </div>
            <small>YOUR AGENT WORKSPACE</small>
            <h1>从一段对话开始</h1>
            <p>
              把 Agent 加进群，直接交流、互相提问。
              <br />
              需要时，再一起写文档、开会或跟进事项。
            </p>
            <Button onClick={() => setModal({ type: "create" })}>
              <Plus size={16} />
              新建群聊
            </Button>
            <button onClick={() => setModal({ type: "import" })}>
              接着聊以前的项目 <ArrowUp size={13} />
            </button>
          </div>
        ) : (
          <>
            <header className="comm-header">
              <div>
                <span className="header-hash">
                  {channel.direct ? <MessageSquare size={23} /> : <Hash size={23} />}
                </span>
                <div>
                  <h1>{channel.name}</h1>
                  <p>
                    {channel.direct ? "单聊 · 只有你和这位 Agent" : <>{groupMembers.length} 位 Agent ·{" "}
                    {channel.coordinatorId
                      ? `${name(channel.coordinatorId)} 负责协调`
                      : "尚未指定负责人"}</>}
                  </p>
                </div>
              </div>
              <div>
                {!channel.direct&&<Button className="meeting-open-button" variant="ghost" onClick={()=>setMeetingPanel({id:snapshot.meetings.find(m=>m.status==='preparing')?.id||null,channelId:current})}><Video size={15}/>开会</Button>}
                {!channel.direct && <><button
                  className="member-stack"
                  aria-label="管理群成员"
                  onClick={() => setModal({ type: "group" })}
                >
                  {groupMembers.slice(0, 4).map((m) => (
                    <Face key={m.id} id={m.id} name={m.name} platformId={m.platformId} small />
                  ))}
                  <Plus size={15} />
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="群设置"
                  onClick={() => setModal({ type: "group" })}
                >
                  <Settings2 size={18} />
                </Button></>}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={side ? "收起协作空间" : "展开协作空间"}
                  onClick={() => setSide(!side)}
                >
                  {side ? (
                    <PanelRightClose size={19} />
                  ) : (
                    <PanelRightOpen size={19} />
                  )}
                </Button>
              </div>
            </header>
            <div className="comm-body">
              <section className="conversation-column">
                <div
                  className="messages-scroll"
                  ref={scroll}
                  onScroll={(e) => {
                    nearBottom.current =
                      e.currentTarget.scrollHeight -
                        e.currentTarget.scrollTop -
                        e.currentTarget.clientHeight <
                      100;
                  }}
                >
                  {moreCursor && (
                    <Button
                      variant="ghost"
                      className="load-older"
                      onClick={loadOlder}
                    >
                      查看更早消息
                    </Button>
                  )}
                  {!messages.length && (
                    <div className="channel-intro">
                      <span>
                        <Hash size={28} />
                      </span>
                      <h2>{channel.name}</h2>
                      <p>
                        {channel.direct?'直接提问、讨论，或让这位 Agent 帮你处理事情。':<>这是你们的群聊。直接提问、讨论或 @ 某位成员。<br/>负责人可以协调，所有人都能自由发言。</>}
                      </p>
                    </div>
                  )}
                  {messages.map((m) => (
                    <article
                      className={
                        "chat-message " +
                        (m.authorId === "owner" ? "owner-message" : "")
                      }
                      id={m.id}
                      key={m.id}
                    >
                      <Face name={name(m.authorId)} id={m.authorId} platformId={[...workspace.members,...(workspace.formerMembers||[])].find(x=>x.id===m.authorId)?.platformId} />
                      <div className="message-content">
                        <header>
                          <strong>{name(m.authorId)}</strong>
                          {m.authorId === channel.coordinatorId && (
                            <span className="coordinator-tag">负责人</span>
                          )}
                          <time>{time(m.createdAt)}</time>
                          <button
                            aria-label={"回复 " + name(m.authorId)}
                            title="回复"
                            onClick={() => {
                              setReply(m);
                              if (m.authorId !== "owner")
                                setMentions([m.authorId]);
                              document
                                .querySelector('[aria-label="群消息"]')
                                ?.focus();
                            }}
                          >
                            <Reply size={15} />
                          </button>
                        </header>
                        {m.replyTo && (
                          <button
                            className="reply-preview"
                            onClick={() =>
                              document
                                .getElementById(m.replyTo)
                                ?.scrollIntoView({
                                  behavior: "smooth",
                                  block: "center",
                                })
                            }
                          >
                            回复{" "}
                            {name(
                              messages.find((p) => p.id === m.replyTo)
                                ?.authorId,
                            )}
                            ：
                            {messages
                              .find((p) => p.id === m.replyTo)
                              ?.body.slice(0, 75) || "较早的消息"}
                          </button>
                        )}
                        {m.mentions?.length > 0 && (
                          <div className="message-mentions">
                            {m.mentions.map((id) => (
                              <span key={id}>@{name(id)}</span>
                            ))}
                          </div>
                        )}
                        {m.type==='shared_file'?<FileCard file={m.fileName?{name:m.fileName,size:m.fileSize}:(snapshot.files||[]).find(f=>f.id===m.resourceId)||{name:m.body}} action={m.resourceAction} version={m.resourceVersion} onOpen={()=>setSharedFileId(m.resourceId)}/>:m.type==='handoff'?<HandoffCard handoff={(snapshot.handoffs||[]).find(h=>h.id===m.handoffId)} summary={m.body} name={name} onOpen={()=>setHandoffId(m.handoffId)}/>:['meeting_start','meeting_end','meeting_result_update'].includes(m.type) ? <MeetingCard meeting={snapshot.meetings.find(mt=>mt.id===m.meetingId)||{id:m.meetingId,title:m.body.split('\n')[0],status:m.type==='meeting_end'?'ended':'running'}} ended={m.type!=='meeting_start'} onOpen={()=>setMeetingPanel({id:m.meetingId,channelId:current})}/> : ["document", "delivery"].includes(m.type) ? (
                          <button
                            className="shared-document-card"
                            onClick={() => setDocumentId(m.documentId)}
                          >
                            <span>
                              <FileText size={21} />
                            </span>
                            <div>
                              <strong>
                                {snapshot.documents.find(
                                  (d) => d.id === m.documentId,
                                )?.title || "共享文档"}
                              </strong>
                              <small>
                                {m.type === "delivery"
                                  ? `已交付 · 第 ${m.version} 版`
                                  : "共同编辑"}{" "}
                                · {m.body}
                              </small>
                            </div>
                            <ArrowUp size={16} />
                          </button>
                        ) : m.type === "question" ? (
                          <Question
                            question={snapshot.decisions.find(
                              (q) => q.id === m.questionId,
                            )}
                            busy={busy}
                            onAnswer={(answer) =>
                              act("channel.answer", {
                                questionId: m.questionId,
                                answer,
                              })
                            }
                          />
                        ) : (
                          <div
                            className="message-markdown"
                            dangerouslySetInnerHTML={{
                              __html: markdown(m.body),
                            }}
                          />
                        )}
                      </div>
                    </article>
                  ))}
                </div>
                {snapshot.activity.some((t) =>
                  [
                    "ready",
                    "active",
                    "limited",
                    "stalled",
                    "unavailable",
                  ].includes(t.status),
                ) && (
                  <div className="conversation-activity">
                    {[
                      ...new Set(
                        snapshot.activity
                          .filter((t) => ["ready", "active"].includes(t.status))
                          .map((t) => t.memberId),
                      ),
                    ].map((mid) => (
                      <span key={mid}>
                        <i
                          className={
                            snapshot.activity.some(
                              (t) =>
                                t.memberId === mid && t.status === "active",
                            )
                              ? "working"
                              : ""
                          }
                        />
                        {name(mid)}{" "}
                        {snapshot.activity.some(
                          (t) => t.memberId === mid && t.status === "active",
                        )
                          ? "正在处理"
                          : snapshot.notifications?.some(
                                (n) =>
                                  n.memberId === mid &&
                                  n.status === "accepted" &&
                                  snapshot.activity.some(
                                    (t) =>
                                      t.id === n.stepId && t.status === "ready",
                                  ),
                              )
                            ? "等待平台唤醒"
                            : "等待投递"}
                      </span>
                    ))}
                    {snapshot.activity.some((t) =>
                      ["limited", "stalled", "unavailable"].includes(t.status),
                    ) && (
                      <button
                        onClick={() => {
                          setTab("activity");
                          setSide(true);
                        }}
                      >
                        有消息尚未回应，查看原因
                      </button>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-2 px-5 pt-2" aria-label="当前聊天的工作会话">{groupMembers.filter(m=>['codex','gemini-cli','antigravity','deepseek-harness','claude-code'].includes(m.platformId)).map(m=>{const local=codingStatus.members.find(r=>r.memberId===m.id),b=local?.assignments?.find(b=>b.channelId===current);return <Button key={m.id} size="sm" variant="outline" onClick={()=>setModal({type:'session',member:m})}>{m.name} · {b?.title&&!/^(?:channel_|原工作会话|新会话|独立工作会话)/.test(b.title)?b.title:b?'更换项目与对话':'选择项目与对话'}</Button>;})}</div>
                <form className="chat-composer" onSubmit={send}>
                  {scopedMeeting&&!reply&&<div className="composing-reply">正在参与会议：{scopedMeeting.title}<button type="button" aria-label="切回普通群聊" onClick={()=>setMeetingScopes(s=>({...s,[current]:null}))}><X size={13}/></button></div>}
                  {reply && (
                    <div className="composing-reply">
                      回复 {name(reply.authorId)}：{reply.body.slice(0, 60)}
                      <button
                        type="button"
                        aria-label="取消回复"
                        onClick={() => setReply(null)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )}
                  {mentions.length > 0 && (
                    <div className="composing-mentions">
                      {mentions.map((mid) => (
                        <button
                          type="button"
                          key={mid}
                          onClick={() =>
                            setMentions((old) => old.filter((x) => x !== mid))
                          }
                        >
                          @{name(mid)} <X size={11} />
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea
                    aria-label="群消息"
                    placeholder={`发消息给 ${channel.name}…`}
                    value={draft}
                    onChange={(e) => {
                      const value = e.target.value;
                      setShowMentions(/@[^\s@]*$/.test(value));
                      setDrafts((old) => ({
                        ...old,
                        [current]: value,
                      }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setShowMentions(false);
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        send();
                      }
                    }}
                  />
                  <div className="composer-toolbar">
                    <div>
                      <UploadFiles key={current} compact channelId={current} onDone={refresh}/>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="提及成员"
                        onClick={() => setShowMentions(!showMentions)}
                      >
                        <AtSign size={17} />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="新建共享文档"
                        onClick={() => setModal({ type: "doc" })}
                      >
                        <FileText size={17} />
                      </Button>
                      {showMentions && (
                        <div className="mention-picker">
                          {groupMembers
                            .filter((m) =>
                              m.name
                                .toLowerCase()
                                .includes(
                                  (
                                    draft.match(/@([^\s@]*)$/)?.[1] || ""
                                  ).toLowerCase(),
                                ),
                            )
                            .map((m) => (
                              <button
                                type="button"
                                key={m.id}
                                aria-label={"提及 " + m.name}
                                onClick={() => {
                                  setMentions((old) => [
                                    ...new Set([...old, m.id]),
                                  ]);
                                  setDrafts((old) => ({
                                    ...old,
                                    [current]: (old[current] || "").replace(
                                      /@[^\s@]*$/,
                                      "",
                                    ),
                                  }));
                                  setShowMentions(false);
                                  document
                                    .querySelector('[aria-label="群消息"]')
                                    ?.focus();
                                }}
                              >
                                <Face small name={m.name} platformId={m.platformId} />
                                {m.name}
                              </button>
                            ))}
                        </div>
                      )}
                      <small>Enter 发送 · Shift + Enter 换行</small>
                    </div>
                    <Button
                      size="icon"
                      aria-label="发送消息"
                      type="submit"
                      disabled={
                        busy || !draft.trim()
                      }
                    >
                      <ArrowUp size={19} />
                    </Button>
                  </div>
                </form>
                <footer className="chat-bottom-note">
                  {lastSync
                    ? `已同步 ${new Date(lastSync).toLocaleTimeString("zh-CN")}`
                    : "同步中"}
                  <span>原生 Agent 异步回应</span>
                </footer>
              </section>
              {meetingPanel?.channelId===current ? <MeetingPanel key={meetingPanel.viewKey||meetingPanel.id||('new:'+current)} initialId={meetingPanel.id} channel={channel} members={workspace.members} connections={workspace.connections} activity={snapshot.activity} notifications={snapshot.notifications} onCreated={id=>setMeetingPanel({id,channelId:current,viewKey:meetingPanel.viewKey||meetingPanel.id||('new:'+current)})} onClose={()=>setMeetingPanel(null)} onChanged={()=>refresh().catch(()=>{})}/> : side && (
                <aside className="collaboration-space">
                  <div className="space-title">
                    <strong>协作空间</strong>
                    <span>需要时再用</span>
                  </div>
                  <nav className="space-tabs">
                    {[
                      ["documents", "资料", FileText],
                      ["tasks", "事项", Columns3],
                      ["meetings", "会议", Video],
                      ["members", "成员", Users],
                    ].map(([id, text, Icon]) => (
                      <button
                        key={id}
                        className={tab === id ? "active" : ""}
                        onClick={() => setTab(id)}
                      >
                        <Icon size={15} />
                        {text}
                      </button>
                    ))}
                  </nav>
                  <div className="space-content">
                    {tab === "documents" ? (
                      <>
                        <SharedFiles key={current} channelId={current} files={snapshot.files||[]} onOpen={setSharedFileId} onDone={refresh}/>
                        <div className="section-heading">
                          <h3>
                            共享文档 <span>{snapshot.documents.length}</span>
                          </h3>
                          <button
                            aria-label="添加共享文档"
                            onClick={() => setModal({ type: "doc" })}
                          >
                            <Plus size={16} />
                          </button>
                        </div>
                        {snapshot.documents.length ? (
                          snapshot.documents.map((d) => (
                            <button
                              className="space-doc"
                              key={d.id}
                              onClick={() => setDocumentId(d.id)}
                            >
                              <FileText size={19} />
                              <div>
                                <strong>{d.title}</strong>
                                <small>
                                  {name(d.lastEditorId)} 更新 · v{d.version}
                                </small>
                              </div>
                              {d.status === "delivered" && <span>已交付</span>}
                            </button>
                          ))
                        ) : (
                          <Empty
                            icon={FileText}
                            text="讨论可以先开始，文档随时共写。"
                          />
                        )}
                        <div className="section-heading lower">
                          <h3>团队知识</h3>
                          <BookOpen size={15} />
                        </div>
                        {snapshot.knowledge.map((k) => (
                          <div className="memory-note" key={k.id}>
                            <strong>{k.title}</strong>
                            <p>{k.body}</p>
                            {k.status === "pending" ? (
                              <div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    act("channel.memory.review", {
                                      memoryId: k.id,
                                      status: "approved",
                                    })
                                  }
                                >
                                  记住
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    act("channel.memory.review", {
                                      memoryId: k.id,
                                      status: "rejected",
                                    })
                                  }
                                >
                                  不用
                                </Button>
                              </div>
                            ) : (
                              <small>
                                {k.status === "approved" ? "已记住" : "未采用"}
                              </small>
                            )}
                          </div>
                        ))}
                        {!snapshot.knowledge.length && (
                          <p className="space-hint">
                            成员提出的经验，经用户确认后保留。
                          </p>
                        )}
                      </>
                    ) : tab === "members" ? (
                      <>
                        <div className="section-heading">
                          <h3>群成员</h3>
                          <button onClick={() => setModal({ type: "group" })}>
                            管理
                          </button>
                        </div>
                        {groupMembers.map((m) => (
                          <div className="space-member" key={m.id}>
                            <Face name={m.name} id={m.id} platformId={m.platformId} />
                            <div>
                              <strong>
                                {m.name}
                                {channel.coordinatorId === m.id && (
                                  <span>负责人</span>
                                )}
                              </strong>
                              <small>
                                {workspace.connections.find(
                                  (c) => c.id === m.id,
                                )?.status === "verified"
                                  ? "自动通道已验证"
                                  : "自动接入未就绪"}
                              </small>
                            </div>
                            <button
                              aria-label={"私聊 " + m.name}
                              onClick={() => openDirect(m).catch(()=>{})}
                            >
                              <MessageSquare size={16} />
                            </button>
                          </div>
                        ))}
                        <p className="space-hint">
                          负责人由用户指定，随时可换。群内其他成员仍可直接交流。
                        </p>
                      </>
                    ) : tab === "tasks" ? (
                      <>
                        <div className="section-heading">
                          <h3>事项看板</h3>
                          <button onClick={() => setModal({ type: "task" })}>
                            <Plus size={16} />
                          </button>
                        </div>
                        {["todo", "doing", "done"].map((status) => (
                          <section className="board-column" key={status}>
                            <h4>
                              {
                                {
                                  todo: "待办",
                                  doing: "进行中",
                                  done: "已完成",
                                }[status]
                              }
                              <span>
                                {
                                  snapshot.tasks.filter(
                                    (t) => t.status === status,
                                  ).length
                                }
                              </span>
                            </h4>
                            {snapshot.tasks
                              .filter((t) => t.status === status)
                              .map((t) => (
                                <div className="board-item" key={t.id}>
                                  <p>{t.title}</p>
                                  <footer>
                                    <small>
                                      {t.assigneeId
                                        ? name(t.assigneeId)
                                        : "未指定成员"}
                                    </small>
                                    <select
                                      aria-label={"事项状态 " + t.title}
                                      value={t.status}
                                      disabled={busy}
                                      onChange={(e) =>
                                        act("channel.task", {
                                          action: "update",
                                          taskId: t.id,
                                          status: e.target.value,
                                        })
                                      }
                                    >
                                      <option value="todo">待办</option>
                                      <option value="doing">进行中</option>
                                      <option value="done">已完成</option>
                                    </select>
                                  </footer>
                                </div>
                              ))}
                          </section>
                        ))}
                      </>
                    ) : tab === "meetings" ? (
                      <>
                        <div className="section-heading">
                          <h3>讨论记录</h3>
                          <button aria-label="筹备新会议" onClick={() => setMeetingPanel({id:null,channelId:current})}>
                            <Plus size={16} />
                          </button>
                        </div>
                        {[...snapshot.meetings,...olderMeetings].filter((m,i,a)=>a.findIndex(x=>x.id===m.id)===i).map((mt) => (
                          <div className="meeting-record" key={mt.id}>
                            <Video size={18} />
                            <button className="meeting-card-open" onClick={()=>setMeetingPanel({id:mt.id,channelId:current})}><strong>{mt.title}</strong></button>
                            <small>
                              {{preparing:'筹备中',running:'讨论中',closing:'整理结果',ended:'已结束',open:'历史讨论',closed:'已记录结论'}[mt.status]||mt.status}
                            </small>
                            {mt.summary && <p>{mt.summary}</p>}
                            {mt.version!==undefined&&<Button size="sm" variant="ghost" onClick={()=>setMeetingPanel({id:mt.id,channelId:current})}>{mt.status==='preparing'?'继续与负责人沟通':'查看会议'}</Button>}
                            {mt.status === "open" && mt.version===undefined && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  setModal({
                                    type: "close-meeting",
                                    meeting: mt,
                                  })
                                }
                              >
                                记录结论
                              </Button>
                            )}
                          </div>
                        ))}
                        {!snapshot.meetings.length && (
                          <Empty
                            icon={Video}
                            text="需要集中讨论时，开一场会。"
                          />
                        )}
                        {meetingCursor&&<Button variant="ghost" onClick={async()=>{try{const d=await api('/v2/meetings?channelId='+current+'&cursor='+encodeURIComponent(meetingCursor));setOlderMeetings(old=>[...old,...d.items]);setMeetingCursor(d.nextCursor);}catch(e){setError(e.message);}}}>查看更早会议</Button>}
                      </>
                    ) : (
                      <>
                        <div className="section-heading">
                          <h3>消息处理记录</h3>
                          <button onClick={() => setTab("members")}>
                            返回
                          </button>
                        </div>
                        {snapshot.activity.map((t) => (
                          <div className="activity-entry" key={t.id}>
                            <strong>{name(t.memberId)}</strong>
                            <span>{statusText[t.status] || t.status}</span>
                            <small>
                              {(t.status === "limited" ? "消息已保留，直接发下一句即可继续交流。" : t.reason) ||
                                t.progress ||
                                (t.status === "ready" &&
                                snapshot.notifications?.find(
                                  (n) => n.stepId === t.id,
                                )?.status === "accepted"
                                  ? "原平台已接收通知，尚未领取；不是已回复"
                                  : null) ||
                                time(
                                  t.completedAt || t.claimedAt || t.createdAt,
                                )}
                            </small>
                          </div>
                        ))}
                        {snapshot.activity.some((t) =>
                          ["stalled", "unavailable"].includes(
                            t.status,
                          ),
                        ) && (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => act("channel.continue")}
                          >
                            重试未回应的成员
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                  <button
                    className="space-activity"
                    onClick={() =>
                      setTab(tab === "activity" ? "documents" : "activity")
                    }
                  >
                    <Clock size={14} />
                    查看消息处理记录
                  </button>
                </aside>
              )}
            </div>
          </>
        )}
      </main>
      {modal && (
        <Modal
          sessionPicker={modal.type==='session'}
          error={error}
          title={
            {
              create: "新建群聊",
              group: "群设置",
              doc: "新建共享文档",
              task: "添加事项",
              meeting: "开始讨论",
              "close-meeting": "记录会议结论",
              connect: <span className="connection-title"><Face platformId={modal.member?.platformId} name={modal.member?.name}/><span>连接 {modal.member?.name}</span></span>,
              session: "选择 " + modal.member?.name + " 的对话",
              disconnect: "解除 " + modal.member?.name + " 的连接？",
              import: "继续以前的项目",
              history: "历史工作区",
            }[modal.type] || "设置"
          }
          description={
            modal.type === "group"
              ? "成员、负责人都由用户决定；更换不会删除聊天或登录资料。"
              : modal.type === "create"
                ? "选好成员就可以开始，不必先想好流程。"
                : modal.type === "session"
                  ? "决定它在这个聊天里接着做哪件事。"
                  : "保留原生 Agent 能力与真实协作记录。"
          }
          onClose={() => setModal(null)}
        >
          {modal.type === "disconnect" ? <div className="space-y-5">
            <p className="leading-7">解除后，{modal.member.name} 会从成员列表和当前群中移出，不能再访问 Hub 或接收新消息。聊天和交付记录会保留，原平台账号及登录不会退出，也不会影响其他成员。</p>
            <div className="flex justify-end gap-3"><Button variant="outline" onClick={()=>setModal(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={async()=>{try{await perform(()=>api('/action',{type:'member.disconnect',memberId:modal.member.id}));setModal(null);setNotice('已解除连接，聊天记录和原平台登录已保留。');}catch{}}}>确认解除连接</Button></div>
          </div> : modal.type === "history" ? (
            <ReadOnlyHistory
              perform={perform}
              onSelect={(c) => {
                setCurrent(c.id);
                setPage("chat");
                setModal(null);
              }}
            />
          ) : ["create", "group"].includes(modal.type) ? (
            <GroupForm
              key={modal.type + current}
              channel={modal.type === "group" ? channel : null}
              workspace={workspace}
              busy={busy}
              onSave={async (values) => {
                try {
                  const c = await perform(() =>
                    command(
                      modal.type === "group"
                        ? "channel.update"
                        : "channel.create",
                      {
                        ...values,
                        ...(modal.type === "group"
                          ? { channelId: current }
                          : {}),
                      },
                    ),
                  );
                  setCurrent(c.id);
                  setPage("chat");
                  setModal(null);
                } catch {}
              }}
            />
          ) : modal.type === "session" ? <ChatSessionPicker member={modal.member} channel={channel} onConnect={()=>setModal({type:'connect',member:modal.member})} onSaved={async()=>{setCodingStatus(await api('/local/coding/status'));await refreshWorkspace();setModal(null);}}/> : modal.type === "connect" ? (
            <Suspense fallback="正在打开接入设置…">
              <ConnectWizard
                member={modal.member}
                connection={workspace.connections.find(
                  (c) => c.id === modal.member.id,
                )}
                refresh={refreshWorkspace}
                notify={setNotice}
                onError={setError}
                onStartChat={openDirect}
              />
            </Suspense>
          ) : modal.type === "import" ? (
            <ImportProjects
              channels={channels}
              perform={perform}
              onSelect={(c) => {
                setCurrent(c.id);
                setPage("chat");
                setModal(null);
              }}
            />
          ) : (
            <ToolForm
              type={modal.type}
              members={groupMembers}
              busy={busy}
              onSave={async (values) => {
                const mapping = {
                  doc: "channel.doc.create",
                  task: "channel.task",
                  meeting: "channel.meeting",
                  "close-meeting": "channel.meeting",
                };
                try {
                  const result = await perform(() =>
                    command(mapping[modal.type], {
                      channelId: current,
                      ...values,
                      ...(modal.type === "task" ? { action: "create" } : {}),
                      ...(modal.type === "meeting" ? { action: "open" } : {}),
                      ...(modal.type === "close-meeting"
                        ? { action: "close", meetingId: modal.meeting.id }
                        : {}),
                    }),
                  );
                  setModal(null);
                  if (modal.type === "doc") setDocumentId(result.id);
                } catch {}
              }}
            />
          )}
        </Modal>
      )}
      {sharedFileId&&<FileDialog id={sharedFileId} name={name} onClose={()=>setSharedFileId(null)} onChanged={refresh}/>}
      {handoffId&&<HandoffDialog id={handoffId} name={name} onClose={()=>setHandoffId(null)} onFile={id=>{setHandoffId(null);setSharedFileId(id);}} onDoc={id=>{setHandoffId(null);setDocumentId(id);}}/>}
      {documentId && (
        <SharedDocument
          id={documentId}
          name={name}
          suggestions={snapshot?.suggestions || []}
          onClose={() => setDocumentId(null)}
          perform={perform}
          channelId={current}
        />
      )}
    </div>
  );
}
function Empty({ icon: Icon, text }) {
  return (
    <div className="space-empty">
      <Icon size={27} strokeWidth={1.3} />
      <p>{text}</p>
    </div>
  );
}
function Question({ question: q, busy, onAnswer }) {
  const [answer, setAnswer] = useState("");
  if (!q) return null;
  return (
    <div className="question-card">
      <strong>{q.question}</strong>
      {q.status === "answered" ? (
        <p>
          <Check size={15} />
          用户选择：{q.answer}
        </p>
      ) : (
        <>
          <div>
            {q.options.map((x) => (
              <Button
                key={x}
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onAnswer(x)}
              >
                {x}
              </Button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (answer.trim()) onAnswer(answer);
            }}
          >
            <Input
              aria-label="自定义回答"
              placeholder="也可以直接说你的想法"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <Button size="sm" disabled={busy || !answer.trim()}>
              回复
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
function GroupForm({ channel, workspace, busy, onSave }) {
  const [name, setName] = useState(channel?.name || ""),
    [ids, setIds] = useState(channel?.memberIds || []),
    [lead, setLead] = useState(channel?.coordinatorId || "");
  return (
    <form
      className="comm-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          name,
          memberIds: ids,
          coordinatorId: lead || null,
        });
      }}
    >
      <label>
        群名称
        <Input
          required
          aria-label="群名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <fieldset>
        <legend>群成员</legend>
        {workspace.members.map((m) => (
          <label className="member-choice" key={m.id}>
            <input
              type="checkbox"
              aria-label={"选择 " + m.name}
              checked={ids.includes(m.id)}
              onChange={(e) => {
                setIds((old) =>
                  e.target.checked
                    ? [...old, m.id]
                    : old.filter((x) => x !== m.id),
                );
                if (!e.target.checked && lead === m.id) setLead("");
              }}
            />
            <Face small name={m.name} platformId={m.platformId} />
            <span>
              {m.name}
              <small>
                {workspace.connections.find((c) => c.id === m.id)?.status ===
                "verified"
                  ? "自动通道已验证"
                  : "可加入群；自动接入尚未就绪"}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        负责人
        <select
          aria-label="群负责人"
          value={lead}
          onChange={(e) => setLead(e.target.value)}
        >
          <option value="">暂不指定</option>
          {workspace.members
            .filter((m) => ids.includes(m.id))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </select>
        <small>负责协调，不限制其他成员发言；用户随时可以更换。</small>
      </label>
      <Button type="submit" disabled={busy || !name.trim()}>
        {channel ? "保存群设置" : "创建并开始沟通"}
      </Button>
    </form>
  );
}
function ToolForm({ type, members, busy, onSave }) {
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [assignee, setAssignee] = useState("");
  return (
    <form
      className="comm-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(
          type === "close-meeting"
            ? { summary: body }
            : {
                title,
                ...(type === "doc" ? { body } : {}),
                ...(type === "task" ? { assigneeId: assignee } : {}),
              },
        );
      }}
    >
      {type !== "close-meeting" && (
        <label>
          {type === "meeting" ? "讨论主题" : "标题"}
          <Input
            required
            aria-label="工具标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
      )}
      {["doc", "close-meeting"].includes(type) && (
        <label>
          {type === "doc" ? "正文" : "会议结论"}
          <Textarea
            required
            aria-label="工具正文"
            className="min-h-40"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
      )}
      {type === "task" && (
        <label>
          执行成员（可选）
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">暂不指定</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button disabled={busy}>保存</Button>
    </form>
  );
}
function ImportProjects({ channels, perform, onSelect }) {
  const [projects, setProjects] = useState([]);
  useEffect(() => {
    api("/v2/projects").then((p) => setProjects(p.items));
  }, []);
  return (
    <div className="comm-form">
      <p>保留原来的记录，开启新的自由沟通。旧任务不会自动重跑。</p>
      {projects
        .filter((p) => !channels.some((c) => c.legacyProjectId === p.id))
        .map((p) => (
          <Button
            variant="outline"
            key={p.id}
            onClick={() =>
              perform(() => command("channel.import", { projectId: p.id }))
                .then(onSelect)
                .catch(() => {})
            }
          >
            {p.name}
          </Button>
        ))}
      <p className="space-hint">
        原来的任务和成果保留在历史工作区；新对话不沿用旧编排。
      </p>
    </div>
  );
}
function Members({ workspace, coding, perform, refresh, setModal, onChat }) {
  const [adding, setAdding] = useState(false),
    [title, setTitle] = useState(""),
    [platform, setPlatform] = useState("grok-bot"),
    [platforms, setPlatforms] = useState([]),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[editing,setEditing]=useState(null),[formError,setFormError]=useState(''),[saving,setSaving]=useState(false);
  useEffect(() => {
    api("/v2/catalog").then((c) => setPlatforms(c.platforms)).catch(e=>setFormError(e.message));
  }, []);
  const platformName=id=>platforms.find(p=>p.id===id)?.name||({'grok-bot':'Grok Bot',dots:'Dot','chatgpt-agent':'Dot',codex:'Codex',antigravity:'Gemini · Antigravity','claude-code':'Claude Code','deepseek-harness':'DeepSeek Harness'}[id]||id);
  const rows=workspace.members.map(m=>{const connection=workspace.connections.find(c=>c.id===m.id),native=['codex','gemini-cli','antigravity','deepseek-harness','claude-code'].includes(m.platformId),local=coding?.members.find(r=>r.memberId===m.id),ready=native?local?.enabled&&['idle','working'].includes(local.status):connection?.status==='verified',verified=ready&&connection?.status==='verified';return{m,native,local,ready,verified,status:local?.status==='working'?'正在工作':verified?'可沟通':ready?'等待首次回复':native&&local?.enabled?'未在线':'未连接'};});
  const visible=rows.filter(({m})=>(filter==='all'||m.platformId===filter)&&(!query.trim()||(m.name+' '+platformName(m.platformId)).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  return (
    <div className="members-page">
      <header>
        <div>
          <h1>成员与连接 <span className="members-count">{rows.length}</span></h1>
          <p>让你正在使用的 Agent 加入协作，继续用各自的模型和工具。</p>
        </div>
        <Button onClick={() => {setFormError('');setAdding(true);}}>
          <Plus size={16} />
          添加成员
        </Button>
      </header>
      <Dialog open={adding} onOpenChange={value=>{if(!saving)setAdding(value);}}><DialogContent className="sm:max-w-[460px]"><DialogHeader><DialogTitle>添加成员</DialogTitle><DialogDescription>连接一个你正在使用的 Agent 账号，给它起个容易辨认的备注。</DialogDescription></DialogHeader>
        <form
          className="comm-form member-add"
          onSubmit={async (e) => {
            e.preventDefault();if(saving)return;setSaving(true);setFormError('');
            try {
              const target = platforms.find(p => p.id === platform);
              if (!target?.registered) try {
                await api("/action", { type: "platform.create", payload: {
                  id: platform, name: target?.name || platform, nativeAgents: true,
                } });
              } catch (error) {
                // Another window may have added this platform concurrently.
                const current = await api("/state");
                if (!current.platforms?.some(p => p.id === platform)) throw error;
              }
              const { result: a } = await perform(() =>
                api("/action", {
                  type: "account.create",
                  payload: { platformId: platform, label: title },
                }),
              );
              const { result: newMember } = await perform(() =>
                api("/action", {
                  type: "member.create",
                  payload: { accountId: a.id, name: title, mode: "connector" },
                }),
              );
              setAdding(false);
              setTitle("");
              await refresh();
              setModal({ type: "connect", member: newMember });
            } catch(e) {setFormError(e.message);}finally{setSaving(false);}
          }}
        >
          <label>
            备注名称
            <Input
              aria-label="成员备注名称"
              value={title}
              required
              maxLength={80}
              placeholder="例如：我的 Codex、团队 Claude"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            平台
            <span className="member-platform-preview"><Face platformId={platform}/><span>{platforms.find(p=>p.id===platform)?.name||platform}</span></span>
            <select
              aria-label="成员平台"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              {platforms.filter(p=>p.id!=='gemini-cli').map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.status === "acceptance_target" ? " · 待联测" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm leading-6 text-muted-foreground">添加的是你正在使用的账号。同一账号的不同项目，在聊天里选择工作会话即可，无需重复添加。</p>
          {formError&&<p role="alert" className="text-sm text-destructive">{formError}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={saving} onClick={()=>setAdding(false)}>取消</Button><Button disabled={saving||!title.trim()}>{saving?'正在添加…':'添加并连接'}</Button></div>
        </form>
      </DialogContent></Dialog>
      <div className="members-toolbar">
        <div className="members-search"><Search size={16}/><Input aria-label="搜索成员" placeholder="搜索成员或平台…" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button type="button" aria-label="清空成员搜索" onClick={()=>setQuery('')}><X size={14}/></button>}</div>
        <select aria-label="筛选成员平台" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部平台</option>{[...new Set(rows.map(r=>r.m.platformId))].map(id=><option key={id} value={id}>{platformName(id)}</option>)}</select>
        <span className="members-summary"><i/>{rows.filter(r=>r.verified).length} 位可沟通</span>
      </div>
      <div className="members-table-wrap"><table className="members-table" aria-label="成员列表"><thead><tr><th>成员</th><th>平台</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>
        {visible.map(({m,native,local,ready,verified,status})=><tr key={m.id}>
          <td><div className="member-identity"><Face name={m.name} id={m.id} platformId={m.platformId}/><div><button className="member-name" onClick={()=>setModal({type:'connect',member:m})}>{m.name}</button><span className="member-caption">{local?.accountLabel||(native?'账号连接':'独立 Agent')}{local?.assignments?.length?' · '+local.assignments.length+' 个聊天':''}</span></div></div></td>
          <td className="member-platform">{platformName(m.platformId)}</td>
          <td><span className={'member-status '+(verified?'is-ready':ready?'is-pending':'is-offline')} title={local?.message||status}><i/>{status}</span></td>
          <td><div className="member-actions"><Button size="sm" variant="outline" disabled={!ready} aria-label={'聊天 '+m.name} onClick={()=>onChat(m).catch(e=>setFormError(e.message))}><MessageSquare size={14}/>聊天</Button><Button size="sm" variant="ghost" aria-label={'连接设置 '+m.name} onClick={()=>setModal({type:'connect',member:m})}>{ready?'连接设置':'去连接'}</Button><DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={'更多操作 '+m.name}><MoreHorizontal size={17}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>{setFormError('');setEditing({member:m,name:m.name});}}>修改备注</DropdownMenuItem><DropdownMenuSeparator/><DropdownMenuItem variant="destructive" onSelect={()=>setModal({type:'disconnect',member:m})}>解除连接</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></td>
        </tr>)}
      </tbody></table>
      {!visible.length&&<div className="members-empty"><Users size={28}/><h2>{rows.length?'没有找到匹配的成员':'把你的第一位 Agent 加进来'}</h2><p>{rows.length?'换一个名字，或者查看全部平台。':'添加后就可以单聊，也可以邀请它加入群聊。'}</p><Button variant="outline" onClick={()=>rows.length?(setQuery(''),setFilter('all')):setAdding(true)}>{rows.length?'清除筛选':'添加成员'}</Button></div>}
      </div>
      <div className="members-footer"><span>{query||filter!=='all'?`显示 ${visible.length} / ${rows.length} 位成员`:`共 ${rows.length} 位成员`}</span><span>账号与原生工作环境由各 Agent 保留</span></div>
      {formError&&!adding&&!editing&&<p role="alert" className="text-sm text-destructive">{formError}</p>}
      <Dialog open={!!editing} onOpenChange={value=>{if(!value&&!saving)setEditing(null);}}><DialogContent className="sm:max-w-[420px]"><DialogHeader><DialogTitle>修改备注</DialogTitle><DialogDescription>改名后，原来的连接和聊天记录会保留。</DialogDescription></DialogHeader><form className="space-y-5" onSubmit={async e=>{e.preventDefault();if(saving)return;setSaving(true);setFormError('');try{await perform(()=>api('/action',{type:'member.update',memberId:editing.member.id,payload:{name:editing.name.trim()}}));await refresh();setEditing(null);}catch(e){setFormError(e.message);}finally{setSaving(false);}}}><Input aria-label="新的成员备注" maxLength={80} required value={editing?.name||''} onChange={e=>setEditing({...editing,name:e.target.value})}/>{formError&&<p role="alert" className="text-sm text-destructive">{formError}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={saving} onClick={()=>setEditing(null)}>取消</Button><Button disabled={saving||!editing?.name.trim()}>{saving?'保存中…':'保存'}</Button></div></form></DialogContent></Dialog>
    </div>
  );
}
function SharedDocument({
  id,
  name,
  onClose,
  perform,
  channelId,
  suggestions,
}) {
  const [doc, setDoc] = useState(null),
    [body, setBody] = useState(""),
    [base, setBase] = useState(0),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false),
    [history, setHistory] = useState(false),
    [reason, setReason] = useState(""),
    [saving, setSaving] = useState(false);
  const load = async () => {
    const d = await api("/v2/channel-doc?id=" + id);
    setDoc(d);
    setBody(d.body);
    setBase(d.version);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [id]);
  const save = async () => {
    setSaving(true);
    try {
      await perform(() =>
        command("channel.doc.edit", {
          documentId: id,
          expectedVersion: base,
          body,
          reason,
        }),
      );
      await load();
      setEditing(false);
      setReason("");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };
  const exportDoc = () => {
    const a = document.createElement("a"),
      url = URL.createObjectURL(new Blob([body], { type: "text/markdown" }));
    a.href = url;
    a.download = (doc.title || "文档").replace(/[\\/]/g, "-") + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="shared-doc-modal sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{doc?.title || "共享文档"}</DialogTitle>
          <DialogDescription>
            v{base} · {name(doc?.lastEditorId)} 最后修改 ·
            共同编辑，保留每个版本
            {doc?.deliveredVersion && base > doc.deliveredVersion && (
              <span> · 新修改尚未交付（上次为 v{doc.deliveredVersion}）</span>
            )}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
        <div className="doc-toolbar">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (editing && body !== doc.body) {
                setError("请先保存修改，再退出编辑。");
                return;
              }
              setEditing(!editing);
            }}
          >
            {editing ? "阅读" : "编辑文档"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setHistory(!history)}
          >
            <History size={14} />
            版本
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigator.clipboard.writeText(body)}
          >
            <Copy size={14} />
            复制
          </Button>
          <Button variant="ghost" size="sm" onClick={exportDoc}>
            <Download size={14} />
            导出
          </Button>
        </div>
        {editing ? (
          <>
            <Textarea
              aria-label="共享文档正文"
              className="shared-doc-editor"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <Input
              aria-label="修改原因"
              placeholder="这次改了什么"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              disabled={saving || !reason.trim() || !body.trim()}
              onClick={save}
            >
              保存修改
            </Button>
          </>
        ) : (
          <div
            className="shared-doc-reading message-markdown"
            dangerouslySetInnerHTML={{ __html: markdown(body) }}
          />
        )}
        {history && (
          <div className="doc-history">
            {doc?.versions.map((v) => (
              <details key={v.id}>
                <summary>
                  v{v.version} · {name(v.authorId)} · {v.reason} ·{" "}
                  {time(v.createdAt)}
                </summary>
                <pre>{v.body}</pre>
              </details>
            ))}
          </div>
        )}
        {suggestions
          .filter((s) => s.documentId === id && s.status === "pending")
          .map((s) => (
            <div className="memory-note" key={s.id}>
              <strong>{name(s.authorId)} 的修改建议</strong>
              <p>{s.reason}</p>
              <details>
                <summary>查看建议稿</summary>
                <pre>{s.body}</pre>
              </details>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  perform(() =>
                    command("channel.suggestion.review", {
                      channelId,
                      suggestionId: s.id,
                      accept: true,
                    }),
                  )
                    .then(load)
                    .catch((e) => setError(e.message))
                }
              >
                采纳
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  perform(() =>
                    command("channel.suggestion.review", {
                      channelId,
                      suggestionId: s.id,
                      accept: false,
                    }),
                  ).catch((e) => setError(e.message))
                }
              >
                不用
              </Button>
            </div>
          ))}
      </DialogContent>
    </Dialog>
  );
}

function ReadOnlyHistory({ perform, onSelect }) {
  const [projects, setProjects] = useState([]),
    [selected, setSelected] = useState(null),
    [error, setError] = useState(""),
    [doc, setDoc] = useState(null);
  useEffect(() => {
    api("/v2/projects")
      .then((p) => setProjects(p.items))
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="comm-form">
      {error && <p role="alert">{error}</p>}
      {!selected ? (
        projects.map((p) => (
          <Button
            key={p.id}
            variant="outline"
            onClick={() =>
              api("/v2/project?id=" + p.id)
                .then(setSelected)
                .catch((e) => setError(e.message))
            }
          >
            {p.name}
          </Button>
        ))
      ) : (
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setSelected(null);
              setDoc(null);
            }}
          >
            返回项目列表
          </Button>
          <h3>{selected.project.name}</h3>
          <p className="space-hint">
            旧记录只供回看。继续沟通将建立新的群，不重跑旧任务。
          </p>
          <Button
            variant="outline"
            onClick={() =>
              perform(() =>
                command("channel.import", { projectId: selected.project.id }),
              )
                .then(onSelect)
                .catch((e) => setError(e.message))
            }
          >
            在新的群聊继续
          </Button>
          {selected.documents.map((d) => (
            <Button
              variant="outline"
              key={d.id}
              onClick={() =>
                api("/v2/document?id=" + d.id)
                  .then(setDoc)
                  .catch((e) => setError(e.message))
              }
            >
              <FileText size={14} />
              {d.title}
            </Button>
          ))}
          {doc && (
            <div
              className="message-markdown"
              dangerouslySetInnerHTML={{
                __html: markdown(doc.working?.body || doc.original?.body || ""),
              }}
            />
          )}
          <details>
            <summary>原始记录（{selected.messages.length}）</summary>
            {selected.messages.map((m) => (
              <div key={m.id} className="activity-entry">
                <small>{time(m.createdAt)}</small>
                <p>{m.body}</p>
              </div>
            ))}
          </details>
        </>
      )}
    </div>
  );
}
