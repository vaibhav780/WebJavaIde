package org.basic.Programs;
import org.testng.Assert;
import org.testng.annotations.Test;

public class Reverse {


    @Test
    public void testReverse(){
        Assert.assertEquals(NumReverse(1234),4321);
        Assert.assertEquals(StringReverse("abc"),"cba");
    }

    public int NumReverse(int num){
        int rem=0,rev=0;
        while(num>0){
            rem=num %10;
            rev=(rev*10)+rem;
            num=num/10;
        }
        return rev;
    }
    public String StringReverse(String input){
        char[] test=input.toCharArray();
        String op="";

        for(int i=test.length-1;i>=0;i--){
            op= op+test[i];
        }
        return op;
    }
}
