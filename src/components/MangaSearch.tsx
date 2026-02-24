import { useState, useEffect, useRef, useCallback } from 'react'
import '../styles/manga-search.css'

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
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

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
      (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
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
        
        const getSize = () => item.getElementsByTagNameNS(nyaaNS, 'size')[0]?.textContent || '??'
        const getSeeders = () => item.getElementsByTagNameNS(nyaaNS, 'seeders')[0]?.textContent || '0'
        const getLeechers = () => item.getElementsByTagNameNS(nyaaNS, 'leechers')[0]?.textContent || '0'
        const getDownloads = () => item.getElementsByTagNameNS(nyaaNS, 'downloads')[0]?.textContent || '0'
        const getInfoHash = () => item.getElementsByTagNameNS(nyaaNS, 'infoHash')[0]?.textContent || ''
        
        const infoHash = getInfoHash()
        const magnet = infoHash 
          ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce`
          : ''

        return {
          title,
          link,
          torrent,
          size: getSize(),
          date: new Date(pubDate).toLocaleDateString(),
          seeders: parseInt(getSeeders(), 10),
          leechers: parseInt(getLeechers(), 10),
          downloads: parseInt(getDownloads(), 10),
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
      </div>
    </div>
  )
}
