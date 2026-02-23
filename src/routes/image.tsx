import { createFileRoute } from '@tanstack/react-router'
import { ConverterPage } from '../components/ConverterPage'

export const Route = createFileRoute('/image')({
  component: ImagePage,
})

function ImagePage() {
  return (
    <ConverterPage
      fileType="image"
      notice="Convert single images or folders of images to 2-bit XTH format. Perfect for wallpapers and backgrounds."
    />
  )
}
