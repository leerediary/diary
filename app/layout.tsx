import type { Metadata, Viewport } from 'next'
import './globals.css'
import Nav from '@/components/Nav'
import Bootstrap from '@/components/Bootstrap'
import RegisterSW from '@/components/RegisterSW'
import SyncTrigger from '@/components/SyncTrigger'
import SyncBanner from '@/components/SyncBanner'
import InstallBanner from '@/components/InstallBanner'
import { LOCAL_ONLY } from '@/lib/local-only'

export const metadata: Metadata = {
  title: '日记',
  applicationName: '日记',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: '日记' },
}

export const viewport: Viewport = {
  themeColor: '#ffffff',
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full flex flex-col">
        <Bootstrap />
        {!LOCAL_ONLY && (<><SyncTrigger /><SyncBanner /></>)}
        {LOCAL_ONLY && <InstallBanner />}
        <RegisterSW />
        <Nav />
        <main className="flex-1 max-w-2xl mx-auto w-full px-6 py-16">
          {children}
        </main>
      </body>
    </html>
  )
}
