import React from 'react';
import { ArrowUpRight, Clock, FileCode2, FolderOpen, Sparkles } from 'lucide-react';
import type { MemberRecord } from '../../shared/types.js';
import { AgentAvatar, BrandLogo } from '../AgentAvatar.js';
import { useI18n } from '../lib/i18n.js';

export function EmptyThreadWelcome({
  threadTitle,
  owner,
  ownerName,
  workspacePath,
  membersCount,
  onPickSpecScenario,
  onPickScheduleScenario,
  onPickFolderScenario,
  onBindFolder,
  onOpenDiscovery
}: {
  threadTitle: string;
  owner: MemberRecord | null;
  ownerName: string;
  workspacePath: string | null;
  membersCount: number;
  onPickSpecScenario: () => void;
  onPickScheduleScenario: () => void;
  onPickFolderScenario: () => void;
  onBindFolder: () => void;
  onOpenDiscovery: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const scenarios = [
    {
      key: 'spec',
      icon: FileCode2,
      tint: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
      title: t('scenarioSpecTitle'),
      desc: t('scenarioSpecDesc'),
      onClick: onPickSpecScenario
    },
    {
      key: 'schedule',
      icon: Clock,
      tint: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      title: t('scenarioScheduleTitle'),
      desc: t('scenarioScheduleDesc'),
      onClick: onPickScheduleScenario
    },
    {
      key: 'folder',
      icon: FolderOpen,
      tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
      title: t('scenarioFolderTitle'),
      desc: t('scenarioFolderDesc'),
      onClick: onPickFolderScenario
    }
  ] as const;

  return (
    <div
      data-testid="empty-thread-welcome"
      className="mx-auto flex w-full max-w-[740px] flex-col items-center justify-center gap-6 px-5 py-10 text-center"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-2.5">
          <BrandLogo size={34} />
          <AgentAvatar name={ownerName} platformId={owner?.platformId} status={owner?.status} />
        </div>
        <h2 className="m-0 text-lg font-semibold tracking-tight text-foreground">{threadTitle}</h2>
        <p className="m-0 max-w-[540px] text-[12.5px] leading-relaxed text-muted-foreground">
          {t('welcomeSubtitle')}
        </p>

        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={onBindFolder}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent"
            title={workspacePath || t('bindFolderBtn')}
          >
            <FolderOpen size={12.5} className="text-muted-foreground" />
            <span className="max-w-[220px] truncate">
              {workspacePath ? workspacePath : t('bindFolderBtn')}
            </span>
          </button>

          {membersCount < 3 && (
            <button
              type="button"
              onClick={onOpenDiscovery}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent"
            >
              <Sparkles size={12.5} className="text-blue-500" />
              <span>{t('discoverShortcutBtn')}</span>
            </button>
          )}
        </div>
      </div>

      <div className="grid w-full grid-cols-1 gap-3 text-left md:grid-cols-3">
        {scenarios.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.key}
              type="button"
              onClick={card.onClick}
              data-testid={`scenario-card-${card.key}`}
              className="group flex flex-col justify-between gap-2.5 rounded-xl border border-border bg-card p-3.5 text-left shadow-xs/5 transition-all hover:border-ring/50 hover:bg-accent/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`flex size-7 items-center justify-center rounded-lg ${card.tint}`}>
                  <Icon size={14} />
                </span>
                <ArrowUpRight
                  size={13}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                />
              </div>
              <div className="space-y-1">
                <div className="text-[12.5px] font-semibold text-foreground">{card.title}</div>
                <p className="m-0 text-[11.5px] leading-relaxed text-muted-foreground">
                  {card.desc}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
