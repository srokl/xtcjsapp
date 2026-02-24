import { useState, useEffect, useRef, useCallback } from 'react'
import WebTorrent from 'webtorrent'
import { formatSize } from '../utils/format'
import '../styles/manga-search.css'

interface TorrentProgress {
  name: string
  progress: number
  speed: number
  downloaded: number
  total: number
  peers: number
  timeRemaining: number
  ready?: boolean
  infoHash: string
}

interface NyaaResult {
  title: string
  link: string
  torrent: string
  size: string
  date: string
  seeders: number
  leechers: number
  downloads: number
  magnet: string
}

export function MangaSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NyaaResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [downloads, setDownloads] = useState<Record<string, TorrentProgress>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const clientRef = useRef<WebTorrent.Instance | null>(null)

  useEffect(() => {
    if (open && !clientRef.current) {
      const client = new WebTorrent()
      clientRef.current = client
      client.on('error', (err) => {
        console.error('[WebTorrent] Error:', err)
      })
    }
    // Note: We keep the client alive even if modal closes to continue downloads
    // But we should probably destroy it on unmount of the app?
    // Since MangaSearch is in __root, it basically persists.
  }, [open])

  const downloadTorrent = useCallback((magnet: string, title: string) => {
    if (!clientRef.current) return

    // Check if torrent already exists by magnet URI or infoHash
    const parsedId = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i)
    const infoHash = parsedId ? parsedId[1].toLowerCase() : null
    
    // Check against current client torrents
    const existing = clientRef.current.torrents.find(t => 
      t.magnetURI === magnet || (infoHash && t.infoHash.toLowerCase() === infoHash)
    )

    if (existing) {
      console.log('Torrent already exists:', existing.name)
      // Optional: Flash the existing download item or show a toast
      return
    }

    try {
      clientRef.current.add(magnet, (torrent) => {
        console.log('Torrent added:', torrent.infoHash)
        
        const updateState = () => {
          setDownloads(prev => ({
            ...prev,
            [torrent.infoHash]: {
              name: torrent.name || title,
              progress: torrent.progress,
              speed: torrent.downloadSpeed,
              downloaded: torrent.downloaded,
              total: torrent.length,
              peers: torrent.numPeers,
              timeRemaining: torrent.timeRemaining,
              infoHash: torrent.infoHash,
              ready: torrent.done
            }
          }))
        }

        torrent.on('download', updateState)
        torrent.on('done', updateState)
        updateState() // Initial
      })
    } catch (err) {
      console.error('Failed to add torrent:', err)
    }
  }, [])

  const saveFile = useCallback((infoHash: string) => {
    const torrent = clientRef.current?.get(infoHash)
    if (!torrent) return

    // For simplicity, download the largest file or zip?
    // Let's iterate files and trigger download for each (or ask user).
    // Just downloading all files as a naive approach.
    torrent.files.forEach(file => {
      file.getBlobURL((err, url) => {
        if (err || !url) return
        const a = document.createElement('a')
        a.href = url
        a.download = file.name
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      })
    })
  }, [])

  const removeTorrent = useCallback((infoHash: string) => {
    clientRef.current?.remove(infoHash)
    setDownloads(prev => {
      const next = { ...prev }
      delete next[infoHash]
      return next
    })
  }, [])

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([])
      return
    }
    setLoading(true)
    setError('')
    
    // Nyaa RSS URL: c=3_1 (Literature - English), f=0 (No filter)
    const targetUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=3_1&f=0`
    
    // Proxies to try in order
    const proxies = [
      (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
      (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      (url: string) => `https://thingproxy.freeboard.io/fetch/${url}`,
      (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ]

    let responseText = ''
    let success = false

    for (const proxyFn of proxies) {
      try {
        const proxyUrl = proxyFn(targetUrl)
        const response = await fetch(proxyUrl)
        if (!response.ok) throw new Error('Network response was not ok')
        responseText = await response.text()
        // Basic check if it looks like XML
        if (responseText.includes('<?xml') || responseText.includes('<rss')) {
          success = true
          break
        }
      } catch (err) {
        console.warn(`Proxy failed:`, err)
        continue
      }
    }

    if (!success) {
      console.error('All proxies failed')
      setError('search-unavailable')
      setResults([])
      setLoading(false)
      return
    }
    
    try {
      const parser = new DOMParser()
      const xml = parser.parseFromString(responseText, 'text/xml')
      const nyaaNS = 'https://nyaa.si/xmlns/nyaa/'
      
      const items = Array.from(xml.querySelectorAll('item'))
      const parsedResults: NyaaResult[] = items.map(item => {
        const title = item.querySelector('title')?.textContent || 'Unknown'
        const link = item.querySelector('guid')?.textContent || ''
        const torrent = item.querySelector('link')?.textContent || ''
        const pubDate = item.querySelector('pubDate')?.textContent || ''
        
        // Helper to extracting Nyaa tags robustly (handling namespace issues)
        const getTag = (tagName: string) => {
          // Try 1: Standard Namespace
          let el = item.getElementsByTagNameNS(nyaaNS, tagName)[0]
          if (el) return el.textContent || ''
          
          // Try 2: Tag name with colon (e.g. nyaa:size)
          el = item.getElementsByTagName(`nyaa:${tagName}`)[0]
          if (el) return el.textContent || ''
          
          // Try 3: Just local name (last resort, might conflict in other feeds but okay here)
          el = item.getElementsByTagName(tagName)[0]
          if (el) return el.textContent || ''
          
          return ''
        }

        const size = getTag('size') || '??'
        const seeders = getTag('seeders') || '0'
        const leechers = getTag('leechers') || '0'
        const downloads = getTag('downloads') || '0'
        const infoHash = getTag('infoHash')
        
        const magnet = infoHash 
          ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce`
          : ''

        return {
          title,
          link,
          torrent,
          size,
          date: new Date(pubDate).toLocaleDateString(),
          seeders: parseInt(seeders, 10),
          leechers: parseInt(leechers, 10),
          downloads: parseInt(downloads, 10),
          magnet
        }
      })

      setResults(parsedResults)
    } catch (err) {
      console.error('Parsing failed:', err)
      setError('search-unavailable')
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100)
    } else {
      setQuery('')
      setResults([])
      setError('')
    }
  }, [open])

  // Debounce at 800ms, or search immediately on Enter
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.trim()) {
      debounceRef.current = setTimeout(() => search(query), 800)
    } else {
      setResults([])
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, search])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      search(query)
    }
  }

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (open) window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="manga-search-overlay" onClick={onClose}>
      <div className="manga-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="manga-search-header">
          <div className="manga-search-header-top">
            <h2>Search Manga</h2>
            <a href="https://thewiki.moe/getting-started/torrenting/" target="_blank" rel="noopener" className="manga-search-hint-underline">
              What is this torrent thing?
            </a>
            <button className="manga-search-close" onClick={onClose} aria-label="Close">
              &times;
            </button>
          </div>
          <p className="manga-search-hint">
            Searching via nyaa.si RSS feed (English Translated)
          </p>
        </div>

        <div className="manga-search-input-wrap">
          <input
            ref={inputRef}
            type="text"
            className="manga-search-input"
            placeholder="Search nyaa.si (English Translated)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {loading && <span className="manga-search-spinner" />}
        </div>

        <div className="manga-search-results">
          {error === 'search-unavailable' && (
            <div className="manga-search-error">
              <p>Unable to fetch results via proxy.</p>
              <p>
                You can search directly on{' '}
                <a
                  href={`https://nyaa.si/?f=0&c=3_1&q=${encodeURIComponent(query)}`}
                  target="_blank"
                  rel="noopener"
                >
                  nyaa.si
                </a>{' '}
                to find English-translated manga.
              </p>
            </div>
          )}
          {!loading && !error && query && results.length === 0 && (
            <p className="manga-search-empty">No results found</p>
          )}
          {results.map((r, i) => (
            <a key={i} className="manga-search-item" href={r.link} target="_blank" rel="noopener">
              <div className="manga-search-item-title">{r.title}</div>
              <div className="manga-search-item-meta">
                <span>{r.size}</span>
                <span className="manga-search-seed">S: {r.seeders}</span>
                <span className="manga-search-leech">L: {r.leechers}</span>
                <span>{r.date}</span>
              </div>
              <div className="manga-search-item-actions" onClick={(e) => e.stopPropagation()}>
                {/* Active Download Progress Inline */}
                {(() => {
                  const parsedId = r.magnet ? r.magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i) : null
                  const infoHash = parsedId ? parsedId[1].toLowerCase() : null
                  const activeDl = infoHash ? Object.values(downloads).find(d => d.infoHash === infoHash) : null

                  if (activeDl) {
                    return (
                      <div className="manga-search-inline-progress" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.75rem', color: 'var(--ink)' }}>
                        <div style={{ width: '60px', height: '4px', background: 'var(--paper-dark)', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{ width: `${activeDl.progress * 100}%`, height: '100%', background: 'var(--accent)' }} />
                        </div>
                        <span>{(activeDl.progress * 100).toFixed(0)}%</span>
                        <span style={{ color: 'var(--ink-faded)' }}>{activeDl.peers} peers</span>
                        <span>{formatSize(activeDl.speed)}/s</span>
                      </div>
                    )
                  }
                  
                  return r.magnet && (
                    <button 
                      className="manga-search-magnet" 
                      title="Download in Browser (WebRTC Only - may not work with all peers)" 
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        downloadTorrent(r.magnet, r.title)
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      Download (WebRTC)
                    </button>
                  )
                })()}

                {r.magnet && (
                  <a href={r.magnet} className="manga-search-magnet" title="Magnet link" onClick={(e) => e.stopPropagation()}>
                    Magnet
                  </a>
                )}
                {r.torrent && (
                  <a href={r.torrent} className="manga-search-magnet" title="Torrent file" onClick={(e) => e.stopPropagation()}>
                    .torrent
                  </a>
                )}
              </div>
            </a>
          ))}
        </div>

        {Object.values(downloads).length > 0 && (
          <div className="manga-search-downloads">
            <h3>Active Downloads</h3>
            {Object.values(downloads).map((d) => (
              <div key={d.infoHash} className="manga-download-item">
                <div className="download-info">
                  <div className="download-name" title={d.name}>{d.name}</div>
                  <div className="download-meta">
                    {formatSize(d.downloaded)} / {formatSize(d.total)} · {(d.progress * 100).toFixed(1)}% · {formatSize(d.speed)}/s · {d.peers} peers
                  </div>
                  <div className="download-progress-bar">
                    <div className="download-progress-fill" style={{ width: `${d.progress * 100}%` }} />
                  </div>
                </div>
                <div className="download-actions">
                  {d.ready && (
                    <button className="btn-save" onClick={() => saveFile(d.infoHash)}>Save</button>
                  )}
                  <button className="btn-cancel" onClick={() => removeTorrent(d.infoHash)}>&times;</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
