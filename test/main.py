from filters import *
from faceRec_MP.mediapipeFilter import filter_clown, filter_pandaFull, filter_cat, filter_panda, stream_face_recognition, apply_faceRec_video
from videomanipulation import filter_video
from basicpicturemanipulation import image_filter
import time
import csv
import os
import pandas as pd
import cv2
from PIL import Image
from fast_ns.experiments.filters_for_images import do_model, evaluate_img
 

#Paths
PATH = "./local_version/front/public/images/input/"
OUTPUTPATH = "./local_version/front/public/images/output/"
FILENAME = './local_version/front/public/images/output/frame.jpg'
CONFIG = "./local_version/front/public/config.csv"
STOPP = "./local_version/front/public/stopStream.txt"
LOCKOUT = './local_version/front/public/images/output/lockOut'


#Files
FRAME = "frame.jpg"
IMAGE = "image.jpg"
PNGIMAGE = "image.png"
VIDEO = "test_vid.mp4"
VIDEO_INPUT = "video.mp4"
VIDEO_OUTPUT = "video.avi"


#Types 
FACE_RECOGNITION = "FaceRecognition"
STYLE_TRANSFER = "StyleTransfer"
NORMAL_FILTER = "NormalFilter"

#Formats 
STREAM = "stream"
VID = "video"
IMG = "image"


#Models for Style-Transfer
CANDY = do_model('local_version/back/fast_ns/experiments/images/21styles/candy.jpg')
STARRY = do_model('local_version/back/fast_ns/experiments/images/21styles/starry_night.jpg')
PENCIL = do_model('local_version/back/fast_ns/experiments/images/21styles/pencil.jpg')

#Translation Dictionary for the lokal and face recognition filters

dict = {"filter1": filter_blurred , "filter2" : filter_flip, "filter3" : filter_pixel,
        "filter4": filter_gray , "filter5" : filter_bw, "filter6" : filter_invert,
        "filter7": filter_sketch , "filter8" : filter_sepia, "filter9" : filter_sharp,
        "filter10": filter_edge , "filter11" : filter_border, "filter12" : filter_reflect,
        "filter13" : filter_wBorder,  
        "filter17" : filter_clown, "filter18": filter_pandaFull, "filter19": filter_cat, "filter20": filter_panda}


model_dict = {"filter14" : CANDY, 
              "filter15" : STARRY ,
            "filter16" :PENCIL }

""" Streams Image with 25 fps 
    Locks the image while it is processed """
def stream25(PATH, filter,FILENAME, model):
    stream_active = True
    while stream_active:
        path = PATH + FRAME
        if os.path.exists(path) and cv.imread(path) is not None: #is file ready?
            if not os.path.exists(LOCKOUT): #did we already display the last image?
                print(path, FILENAME, filter)         
                if model == NORMAL_FILTER:
                    image_filter(path, filter, FILENAME) #Image is augmented with local filter
                else:
                    try:
                        evaluate_img(model, path, FILENAME)
                    except:
                        print("image was truncated")
                
                open(LOCKOUT, "x")
                file = FRAME
                os.remove(os.path.join(PATH, file))
            else:
                print("lockOut already there | not worked with on canvis")
        else:
            print("input file cant be found")
        stream_active = os.path.exists(STOPP) == False
        if os.path.exists(STOPP):
            os.remove(STOPP)
            return
        time.sleep(0.04)


def read_config():
    config = pd.read_csv(CONFIG)
    config = config.to_string()
    counter = 0
    with open(CONFIG, "r") as csvFile:
        #TODO change config to better readable csv format
        csvReader = csv.reader(csvFile)
        for row in csvReader:
            if(counter == 0 ): 
                format = row[0]
                counter+=1
                continue
            if(counter == 1 ):
                filter = row[0]
                counter += 1
                continue
            type = row[0]
        print(type, filter, format)

    return format, type, filter



def translate_config(format, type, filter):
    if type == NORMAL_FILTER:
        if format == STREAM:
            stream25(PATH, dict[filter], FILENAME, NORMAL_FILTER)
        elif format == VID:
            filter_video(PATH + VIDEO_INPUT, dict[filter], OUTPUTPATH + VIDEO_OUTPUT)
        elif format == IMG:
            image_filter(PATH + PNGIMAGE, dict[filter], OUTPUTPATH + IMAGE)

    elif type == FACE_RECOGNITION:
        if format == STREAM:
            stream_face_recognition(PATH, dict[filter], FILENAME)
        elif format == VID:
            apply_faceRec_video(PATH + VIDEO_INPUT, dict[filter], OUTPUTPATH + VIDEO_OUTPUT)
        elif format == IMG:
            image_filter(PATH + PNGIMAGE, dict[filter], OUTPUTPATH + IMAGE)

    elif type == STYLE_TRANSFER:

        model = model_dict[filter] #choose the correct model
        if format == STREAM:
                stream25(PATH, "NAN", FILENAME, model)
        elif format == VID:
            filter_video(PATH + VIDEO_INPUT,model,  OUTPUTPATH + VIDEO_OUTPUT)
            
        elif format == IMG:

            try:
                evaluate_img(model, PATH + PNGIMAGE, OUTPUTPATH + IMAGE)
            except:
                print("image was truncated")

            

"""The main while loop for the python script"""
"""Waits for Information from Node.js Server"""

def main():
    while True:
        
        time.sleep(1)
        print("Try to read: ", CONFIG)
        file_exists = os.path.exists(CONFIG)
        if file_exists:
            format, type, filter = read_config()

            if any(char.isdigit() for char in filter) and (STREAM in format or IMG in format or VID in format): 
                translate_config(format, type, filter)
            else:
                print("wrong filter or format in config file!!")
                time.sleep(1)
            os.remove(CONFIG)
            time.sleep(0.1)
        else:
            print("no config file")
            time.sleep(0.1)


if __name__ == '__main__':
    main()
