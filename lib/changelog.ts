/**
 * App changelog (更新日志). Append the newest entry at the TOP each time you
 * publish a new build to the mirror — this is the single source of truth for
 * both the in-app changelog view (components/Changelog.tsx) and the "what's new"
 * version stamp (components/UpdateBanner.tsx). It ships inside the bundle, so
 * it is always versioned with the code and available offline.
 *
 * version: short human label for the release (shown in the version stamp).
 * date:    ISO date (YYYY-MM-DD) of the publish.
 * title:   one-line summary.
 * notes:   bullet points, each one line.
 */

export interface ChangelogEntry {
  version: string
  date: string
  title: string
  notes: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.5',
    date: '2026-10-16',
    title: '番茄钟提前结束',
    notes: [
      '专注中可「提前结束」，实际时长按四舍五入的分钟记录',
    ],
  },
  {
    version: '1.4',
    date: '2026-10-16',
    title: '番茄钟跳过休息',
    notes: [
      '休息界面新增「跳过休息」，直接回到开始界面继续下一个番茄',
    ],
  },
  {
    version: '1.3',
    date: '2026-10-16',
    title: '番茄钟记住上次笔记',
    notes: [
      '番茄钟完成后记住最后一条笔记，下一个番茄钟可一键再次添加',
    ],
  },
  {
    version: '1.2',
    date: '2026-10-08',
    title: '更新提醒 + 更新日志',
    notes: [
      '新版本上线时，底部提醒刷新',
      '设置页新增「更新日志」，可查看每次更新内容',
    ],
  },
  {
    version: '1.1',
    date: '2026-07-02',
    title: '圣女果短计时 + 时区修复',
    notes: [
      '新增「圣女果」短计时模式（7–15 分钟）',
      '番茄记录跟随设备时区，按本地日期归位',
      '进行中的番茄笔记可以编辑',
    ],
  },
  {
    version: '1.0',
    date: '2026-06-06',
    title: '首次公开发布',
    notes: ['本地离线版上线，可添加到主屏幕使用'],
  },
]

/** Newest release (CHANGELOG[0]) — used for the "what's new" version stamp. */
export const LATEST_VERSION: string = CHANGELOG[0]?.version ?? ''
