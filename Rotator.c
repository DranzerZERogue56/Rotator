#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma pack(push, 1) // Ensure proper alignment of BMP structures

typedef struct
{
    unsigned short bfType;
    unsigned int bfSize;
    unsigned short bfReserved1;
    unsigned short bfReserved2;
    unsigned int bfOffBits;
} BITMAPFILEHEADER;

typedef struct
{
    unsigned int biSize;
    int biWidth;
    int biHeight;
    unsigned short biPlanes;
    unsigned short biBitCount;
    unsigned int biCompression;
    unsigned int biSizeImage;
    int biXPelsPerMeter;
    int biYPelsPerMeter;
    unsigned int biClrUsed;
    unsigned int biClrImportant;
} BITMAPINFOHEADER;

#pragma pack(pop)

void rotate(const char *path, const char *newPath, int mode)
{
    FILE *file = fopen(path, "rb");
    if (!file)
    {
        printf("Error: Cannot open file %s\n", path);
        return;
    }

    BITMAPFILEHEADER fileHeader;
    BITMAPINFOHEADER infoHeader;

    fread(&fileHeader, sizeof(BITMAPFILEHEADER), 1, file);
    fread(&infoHeader, sizeof(BITMAPINFOHEADER), 1, file);

    if (fileHeader.bfType != 0x4D42)
    { // Check if BMP
        printf("Error: Not a valid BMP file\n");
        fclose(file);
        return;
    }

    int width = infoHeader.biWidth;
    int height = abs(infoHeader.biHeight);
    int rowSize = (width * 3 + 3) & ~3;
    unsigned char *data = (unsigned char *)malloc(rowSize * height);

    if (!data)
    {
        printf("Error: Memory allocation failed\n");
        fclose(file);
        return;
    }
    fread(data, 1, rowSize * height, file);
    fclose(file);

    int newWidth = width, newHeight = height;
    if (mode == 1 || mode == 3)
    {
        newWidth = height;
        newHeight = width;
    }
    int newRowSize = (newWidth * 3 + 3) & ~3;
    unsigned char *newData = (unsigned char *)malloc(newRowSize * newHeight);
    if (!newData)
    {
        printf("Error: Memory allocation failed\n");
        free(data);
        return;
    }
    memset(newData, 0, newRowSize * newHeight);

    for (int y = 0; y < height; y++)
    {
        for (int x = 0; x < width; x++)
        {
            int srcIndex = y * rowSize + x * 3;
            int dstIndex = 0;

            switch (mode)
            {
            case 0:
                dstIndex = y * newRowSize + x * 3;
                break; // Copy
            case 1:
                dstIndex = x * newRowSize + (newWidth - 1 - y) * 3;
                break; // 90°
            case 2:
                dstIndex = (newHeight - 1 - y) * newRowSize + (newWidth - 1 - x) * 3;
                break; // 180°
            case 3:
                dstIndex = (newHeight - 1 - x) * newRowSize + y * 3;
                break; // 270°
            case 4:
                dstIndex = y * newRowSize + (newWidth - 1 - x) * 3;
                break; // Mirror
            case 5:
                dstIndex = (newHeight - 1 - y) * newRowSize + x * 3;
                break; // Flip
            default:
                free(data);
                free(newData);
                return;
            }

            memcpy(&newData[dstIndex], &data[srcIndex], 3);
        }
    }

    free(data);

    infoHeader.biWidth = newWidth;
    infoHeader.biHeight = (infoHeader.biHeight > 0) ? newHeight : -newHeight;
    infoHeader.biSizeImage = newRowSize * newHeight;
    fileHeader.bfSize = fileHeader.bfOffBits + infoHeader.biSizeImage;

    FILE *newFile = fopen(newPath, "wb");
    if (!newFile)
    {
        printf("Error: Cannot create file %s\n", newPath);
        free(newData);
        return;
    }

    fwrite(&fileHeader, sizeof(BITMAPFILEHEADER), 1, newFile);
    fwrite(&infoHeader, sizeof(BITMAPINFOHEADER), 1, newFile);
    fwrite(newData, 1, newRowSize * newHeight, newFile);

    fclose(newFile);
    free(newData);

    printf("Image saved to %s\n", newPath);
}