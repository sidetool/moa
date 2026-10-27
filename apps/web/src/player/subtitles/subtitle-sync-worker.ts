import {alignCueTimes,cueTimes} from './subtitle-timing';
self.onmessage=(event:MessageEvent<{candidate:string;reference:string}>)=>{
  try{self.postMessage(alignCueTimes(cueTimes(event.data.candidate),cueTimes(event.data.reference)));}
  catch{self.postMessage({status:'uncertain',offsetSeconds:0,match:0});}
};
