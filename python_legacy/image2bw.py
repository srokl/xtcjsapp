#!/usr/bin/env python3
"""
image2bw - Convert images to 1-bit black & white BMP for XTEink X4 backgrounds
Creates ultra-fast loading images perfect for backgrounds

Usage:
    image2bw image.jpg                       # Default: Floyd-Steinberg dithering
    image2bw image.jpg --no-dither           # Pure threshold (sharpest text)
    image2bw image.jpg --dither ordered      # Ordered dithering (grid pattern)
    image2bw image.jpg --dither rasterize    # Rasterize (halftone-like)
    image2bw folder/                         # Convert all images in folder

Dithering algorithms:
    floyd (default)  - Floyd-Steinberg diffusion (good for photos, smooth gradients)
    ordered          - Ordered/Bayer dithering (regular grid pattern, good for text)
    rasterize        - Halftone-like pattern (newspaper style)
    none             - Pure threshold at 50% (sharpest, best for clean line art)

Note: Always outputs BMP format (XTEink X4 doesn't support PNG images)
"""

import sys
from pathlib import Path
from PIL import Image


# Configuration
TARGET_WIDTH = 480
TARGET_HEIGHT = 800
SUPPORTED_FORMATS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tiff', '.tif'}

# Dithering algorithm descriptions
DITHER_ALGORITHMS = {
    'floyd': {
        'mode': Image.Dither.FLOYDSTEINBERG,
        'desc': 'Floyd-Steinberg diffusion - smooth, good for photos/gradients'
    },
    'ordered': {
        'mode': Image.Dither.ORDERED,
        'desc': 'Ordered/Bayer dithering - grid pattern, often better for text'
    },
    'rasterize': {
        'mode': Image.Dither.RASTERIZE,
        'desc': 'Rasterize - halftone newspaper style'
    },
    'none': {
        'mode': Image.Dither.NONE,
        'desc': 'Pure threshold - sharpest, best for clean line art'
    }
}


def convert_to_bw(input_path, dither_algo='floyd'):
    """
    Convert image to 1-bit black & white BMP
    
    Args:
        input_path: Path to input image
        dither_algo: 'floyd', 'ordered', 'rasterize', or 'none'
    
    Returns:
        Output file path or None if failed
    """
    try:
        # Open and convert to grayscale
        img = Image.open(input_path)
        if img.mode != 'L':
            img = img.convert('L')
        
        # Resize to fit screen while maintaining aspect ratio
        img_width, img_height = img.size
        scale = min(TARGET_WIDTH / img_width, TARGET_HEIGHT / img_height)
        
        new_width = int(img_width * scale)
        new_height = int(img_height * scale)
        
        img_resized = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
        
        # Create white background
        result = Image.new('L', (TARGET_WIDTH, TARGET_HEIGHT), color=255)
        
        # Center the image
        x = (TARGET_WIDTH - new_width) // 2
        y = (TARGET_HEIGHT - new_height) // 2
        
        result.paste(img_resized, (x, y))
        
        # Convert to 1-bit B&W with selected algorithm
        dither_mode = DITHER_ALGORITHMS[dither_algo]['mode']
        bw_img = result.convert('1', dither=dither_mode)
        
        # Generate output filename (always BMP)
        output_name = f"{input_path.stem}_bw_{dither_algo}.bmp"
        output_path = input_path.parent / output_name
        
        # Save as BMP
        bw_img.save(output_path, 'BMP')
        
        # Get file size
        size_kb = output_path.stat().st_size / 1024
        
        print(f"  ✓ {output_path.name} ({size_kb:.1f}KB)")
        return output_path
        
    except Exception as e:
        print(f"  ✗ Error: {e}")
        return None


def main():
    print("=" * 60)
    print("Image to 1-bit B&W BMP Converter for XTEink X4")
    print("Perfect for fast-loading backgrounds")
    print("=" * 60)
    
    args = sys.argv[1:]
    
    if not args or "--help" in args or "-h" in args:
        print("\nUsage:")
        print("  image2bw image.jpg                      # Default (Floyd-Steinberg)")
        print("  image2bw image.jpg --dither ordered     # Use ordered dithering")
        print("  image2bw image.jpg --dither none        # No dithering (sharpest)")
        print("  image2bw folder/                        # Convert all images")
        print("\nDithering algorithms:")
        for algo, info in DITHER_ALGORITHMS.items():
            print(f"  {algo:12} - {info['desc']}")
        print("\nFor text-heavy manga (like Hunter x Hunter):")
        print("  Try: --dither none     (sharpest text)")
        print("  Or:  --dither ordered  (grid pattern, often clearer)")
        print("\nOutput: 480x800 1-bit BMP images")
        print("File size: Usually 15-40KB (ultra-fast loading!)")
        print("\nNote: Always outputs BMP (XTEink X4 doesn't support PNG)")
        return 0
    
    # Parse dithering algorithm
    dither_algo = 'floyd'  # default
    if '--dither' in args:
        dither_idx = args.index('--dither')
        if dither_idx + 1 < len(args):
            specified_algo = args[dither_idx + 1].lower()
            if specified_algo in DITHER_ALGORITHMS:
                dither_algo = specified_algo
            else:
                print(f"Warning: Unknown algorithm '{specified_algo}', using 'floyd'")
    elif '--no-dither' in args:
        dither_algo = 'none'
    
    # Get input path
    input_path = None
    for arg in args:
        if not arg.startswith('--') and arg not in DITHER_ALGORITHMS:
            input_path = Path(arg)
            break
    
    if not input_path or not input_path.exists():
        print("Error: No valid input file or folder specified")
        return 1
    
    print(f"\nInput: {input_path.absolute()}")
    print(f"Output format: BMP (1-bit black & white)")
    print(f"Dithering: {dither_algo.upper()} - {DITHER_ALGORITHMS[dither_algo]['desc']}")
    print(f"Target size: 480x800 pixels")
    print("-" * 60)
    
    # Process based on input type
    if input_path.is_file():
        # Single file
        print(f"\nProcessing: {input_path.name}")
        result = convert_to_bw(input_path, dither_algo)
        success_count = 1 if result else 0
        total_count = 1
    else:
        # Folder
        image_files = []
        for ext in SUPPORTED_FORMATS:
            image_files.extend(sorted(input_path.glob(f"*{ext}")))
            image_files.extend(sorted(input_path.glob(f"*{ext.upper()}")))
        
        image_files = sorted(set(image_files), key=lambda x: x.name.lower())
        
        if not image_files:
            print(f"No image files found in {input_path}")
            return 1
        
        print(f"\nFound {len(image_files)} image(s)")
        print("Processing...\n")
        
        success_count = 0
        for img_path in image_files:
            print(f"{img_path.name}...", end=" ")
            if convert_to_bw(img_path, dither_algo):
                success_count += 1
        
        total_count = len(image_files)
    
    print("-" * 60)
    print(f"\nCompleted! Successfully converted {success_count}/{total_count}")
    print("\nThese 1-bit BMP images should load INSTANTLY on your XTEink X4!")
    print("Perfect for backgrounds and fast display.")
    
    if input_path.is_file() and success_count > 0:
        print(f"\nTip: Try different algorithms to see which looks best:")
        print(f"  image2bw {input_path.name} --dither none")
        print(f"  image2bw {input_path.name} --dither ordered")
    
    return 0 if success_count == total_count else 1


if __name__ == "__main__":
    sys.exit(main())
