import { createFileRoute } from '@tanstack/react-router'
import { ConverterPage } from '../components/ConverterPage'

export const Route = createFileRoute('/video')({
  component: VideoPage,
})

function VideoPage() {
  return (
    <ConverterPage
      fileType="video"
      notice="Extract frames from video files at custom FPS and convert to XTC/XTCH. Perfect for short animations or clips."
    />
  )
}
