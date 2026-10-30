import React, { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { memberName } from "./api.mjs";
export function CheckSummary({ doc, criteria = [], members }) {
  const [open, setOpen] = useState(false);
  const checks = doc.selfCheck || [],
    historical =
      doc.selfCheckVersionId && doc.workingVersionId !== doc.selfCheckVersionId;
  const failed = checks.filter((c) => !c.pass);
  return (
    <div className="my-5 border-y py-4">
      <button
        className={
          "flex items-center gap-2 text-sm " +
          (historical
            ? "text-muted-foreground"
            : failed.length
              ? "state-red"
              : "text-primary")
        }
        onClick={() => setOpen(!open)}
      >
        <Check size={15} />
        {historical
          ? "自查基于先前交付版本 · 之后有你的修改"
          : doc.partial
            ? "部分交付 · 缺少成员交付"
            : doc.qualityIssues?.length
              ? "部分达标 · 展开查看缺口"
              : checks.length
                ? failed.length
                  ? `部分达标 · ${failed.length} 项未达标`
                  : `合格标准 ${checks.length}/${criteria.length || checks.length} 符合`
                : "尚无成员自查结果"}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="check-list mt-3">
          {checks.map((c, i) => (
            <section key={i}>
              <strong className={c.pass ? "" : "state-red"}>
                {c.pass ? "符合" : "不符合"} ·{" "}
                {criteria[c.criterion] || c.title || `标准 ${i + 1}`}
              </strong>
              <p>{c.reason}</p>
              <small>
                检查者：{memberName(members, doc.checkedBy || doc.memberId)} ·
                对应段落：{c.paragraph || "未提供"}
              </small>
            </section>
          ))}
          {!checks.length && <p>成员尚未提交自查，不据此判定达标。</p>}
          {doc.qualityIssues?.length > 0 && (
            <p className="state-red">{doc.qualityIssues.join("；")}</p>
          )}
        </div>
      )}
    </div>
  );
}
