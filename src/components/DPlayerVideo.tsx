import { useEffect, useRef } from "react";
import DPlayer from "dplayer";

interface DPlayerVideoProps {
  url: string;
  poster?: string;
}

export function DPlayerVideo({ url, poster }: DPlayerVideoProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const player = new DPlayer({
      container: containerRef.current,
      video: {
        url,
        pic: poster,
        type: "auto"
      },
      autoplay: false,
      preload: "metadata",
      mutex: true
    });

    return () => player.destroy();
  }, [poster, url]);

  return <div className="dplayer-shell" ref={containerRef} />;
}
