export function samplePlan() {
 const slots = ['breakfast', 'lunch', 'dinner'];
 const names = ['Berry oatmeal','Apple and seed bowl','Banana breakfast oats','Chickpea rice bowl','Lentil vegetable soup','White bean salad','Roasted vegetable rice','Lemon chickpea skillet','Warm lentil bowl'];
 const recipes = Array.from({length:9},(_,i)=>({id:`r${i}`,title:names[i],slot:slots[Math.floor(i/3)],description:'A simple bowl with vegetables and whole grains.',minutes:20,reason:'Offers varied whole grains and vegetables.',basisIds:['profile:goals'],steps:['Cook rice in water. Warm the broccoli and chickpeas, then combine.'],ingredients:[{name:'Brown rice (dry)',quantity:50,unit:'g',costLow:20,costHigh:40},{name:'Broccoli',quantity:100,unit:'g',costLow:50,costHigh:80},{name:'Chickpeas',quantity:100,unit:'g',costLow:40,costHigh:60}]}));
 return {recipes};
}
