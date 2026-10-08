"use client"

import * as React from "react"

type ImageStatus = "idle" | "loading" | "loaded" | "error"

// Image URLs that have already loaded in this browser session. A remount
// (navigating between modules, sidebar collapse/expand) starts these as loaded
// so the fallback initials never flash over an image the browser already has.
const loadedSrcs = new Set<string>()

const initialStatus = (src: string | undefined): ImageStatus =>
  !src ? "idle" : loadedSrcs.has(src) ? "loaded" : "loading"

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect

const AvatarContext = React.createContext<{ onStatusChange: (status: ImageStatus) => void; status: ImageStatus } | null>(null)

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> { }

const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ className, ...props }, ref) => {
    const [status, setStatus] = React.useState<ImageStatus>("idle")
    const context = React.useMemo(() => ({ status, onStatusChange: setStatus }), [status])
    return (
      <AvatarContext.Provider value={context}>
        <div
          ref={ref}
          className={`relative inline-flex h-10 w-10 shrink-0 overflow-hidden rounded-full bg-gray-100 ${className}`}
          {...props}
        />
      </AvatarContext.Provider>
    )
  }
)
Avatar.displayName = "Avatar"

export interface AvatarImageProps
  extends React.ImgHTMLAttributes<HTMLImageElement> { }

const AvatarImage = React.forwardRef<HTMLImageElement, AvatarImageProps>(
  ({ src: rawSrc, className, onLoad, onError, ...rest }, ref) => {
    const src = typeof rawSrc === "string" && rawSrc ? rawSrc : undefined
    const context = React.useContext(AvatarContext)
    const [current, setCurrent] = React.useState(() => ({ src, status: initialStatus(src) }))
    // Last image that actually loaded: kept on screen while a changed src loads.
    const [previousSrc, setPreviousSrc] = React.useState<string | undefined>(() =>
      initialStatus(src) === "loaded" ? src : undefined,
    )

    // A new src restarts loading during render, so there is never a frame that
    // shows the new src marked as loaded (or the old one marked as failed).
    if (current.src !== src) {
      setCurrent({ src, status: initialStatus(src) })
    }

    const markLoaded = React.useCallback((loadedSrc: string) => {
      loadedSrcs.add(loadedSrc)
      setCurrent((prev) => (prev.src === loadedSrc ? { ...prev, status: "loaded" } : prev))
      setPreviousSrc(loadedSrc)
    }, [])

    const markFailed = React.useCallback((failedSrc: string) => {
      loadedSrcs.delete(failedSrc)
      // A definitive failure: show initials, never retry the same URL in this mount.
      setCurrent((prev) => (prev.src === failedSrc ? { ...prev, status: "error" } : prev))
    }, [])

    // A server-rendered <img> can finish loading before React hydrates and
    // attaches onLoad, so that event is never delivered. Read the element's own
    // state when it mounts instead of waiting for an event that already fired.
    const setImageNode = React.useCallback(
      (node: HTMLImageElement | null) => {
        if (typeof ref === "function") ref(node)
        else if (ref) ref.current = node
        if (!node || !src || !node.complete) return
        if (node.naturalWidth > 0) markLoaded(src)
        else markFailed(src)
      },
      [ref, src, markLoaded, markFailed],
    )

    const status = current.src === src ? current.status : initialStatus(src)
    const visibleSrc = status === "loaded" ? src : status === "loading" ? previousSrc : undefined

    const onStatusChange = context?.onStatusChange
    useIsomorphicLayoutEffect(() => {
      onStatusChange?.(visibleSrc ? "loaded" : status)
    }, [onStatusChange, visibleSrc, status])
    useIsomorphicLayoutEffect(() => () => onStatusChange?.("idle"), [onStatusChange])

    if (!src || status === "error") return null

    const imageClassName = `aspect-square h-full w-full object-cover ${className ?? ""}`

    return (
      <>
        {visibleSrc && visibleSrc !== src && (
          // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
          <img key={visibleSrc} src={visibleSrc} className={imageClassName} {...rest} />
        )}
        {/* eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element */}
        <img
          key={src}
          ref={setImageNode}
          src={src}
          className={status === "loaded" ? imageClassName : `${imageClassName} invisible absolute`}
          {...rest}
          onLoad={(e) => {
            markLoaded(src)
            onLoad?.(e)
          }}
          onError={(e) => {
            markFailed(src)
            onError?.(e)
          }}
        />
      </>
    )
  }
)
AvatarImage.displayName = "AvatarImage"

export interface AvatarFallbackProps
  extends React.HTMLAttributes<HTMLDivElement> { }

const AvatarFallback = React.forwardRef<HTMLDivElement, AvatarFallbackProps>(
  ({ className, ...props }, ref) => {
    // Initials only when there is no image on screen.
    if (React.useContext(AvatarContext)?.status === "loaded") return null
    return (
      <div
        ref={ref}
        className={`flex h-full w-full items-center justify-center bg-gray-200 font-medium text-gray-700 ${className}`}
        {...props}
      />
    )
  }
)
AvatarFallback.displayName = "AvatarFallback"

export { Avatar, AvatarImage, AvatarFallback }
